/**
 * HTTP Transport Adapter implementation
 * Provides HTTP-based communication with MCP servers
 */

import { Transport } from '@modelcontextprotocol/sdk/shared/transport';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types';
import { RequestOptions, TransportAdapter } from '../../core/types';

/**
 * HTTP Adapter options
 */
export interface HTTPAdapterOptions {
  /** Default request timeout in milliseconds */
  defaultTimeout?: number;
  /** Default headers to include in all requests */
  defaultHeaders?: Record<string, string>;
  /** Whether to follow redirects */
  followRedirects?: boolean;
  /** Maximum number of redirects to follow */
  maxRedirects?: number;
  /** Base URL for MCP server */
  baseUrl?: string;
}

/**
 * HTTP Transport Adapter
 * Implements the TransportAdapter interface for HTTP communication
 * Also implements the MCP Transport interface for standardized communication
 */
export class HTTPAdapter implements TransportAdapter, Transport {
  private options: HTTPAdapterOptions;
  private controller: AbortController | null = null;
  private baseUrl: string;
  private endpoint: URL | null = null;

  // MCP Transport interface callbacks
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  /**
   * Create a new HTTP adapter
   * @param options Adapter options
   */
  constructor(options: HTTPAdapterOptions = {}) {
    this.options = {
      defaultTimeout: 10000,
      followRedirects: true,
      maxRedirects: 5,
      ...options
    };

    this.baseUrl = options.baseUrl || '';
    this.sessionId = `session-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Starts the transport connection to the MCP server
   * This is a required method from the MCP Transport interface
   */
  async start(): Promise<void> {
    try {
      // In a real implementation, we might need to establish a connection
      // or perform a handshake with the server here.

      // For HTTP-based transports, we may use SSE to receive messages
      // and a separate POST endpoint to send messages.
      // We're setting a default endpoint based on the baseUrl
      this.endpoint = new URL(`${this.baseUrl}/messages`);
    } catch (error) {
      if (error instanceof Error && this.onerror) {
        this.onerror(error);
      }
      throw error;
    }
  }

  /**
   * Send a JSON-RPC message to the MCP server
   * This is a required method from the MCP Transport interface
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.endpoint) {
      throw new Error('Transport not started or endpoint not set');
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.options.defaultHeaders
      };

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: this.controller?.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && this.onerror) {
        this.onerror(error);
      }
      throw error;
    }
  }

  /**
   * Send an HTTP request to the MCP server
   * @param url Request URL
   * @param options Request options
   * @returns Promise resolving to the response
   */
  async request<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      headers = {},
      body,
      timeout = this.options.defaultTimeout,
      responseFormat = 'json'
    } = options;

    // Create abort controller for timeout handling
    this.controller = new AbortController();
    const { signal } = this.controller;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      this.controller?.abort();
    }, timeout);

    try {
      // Prepare headers
      const mergedHeaders: Record<string, string> = {
        ...this.options.defaultHeaders,
        ...headers
      };

      // Add content-type header for requests with body
      if (body && !mergedHeaders['Content-Type']) {
        mergedHeaders['Content-Type'] = 'application/json';
      }

      // Prepare request options
      const fetchOptions: RequestInit = {
        method,
        headers: mergedHeaders,
        signal,
        redirect: this.options.followRedirects ? 'follow' : 'manual'
      };

      // Add body if present
      if (body) {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      // Send request
      const response = await fetch(url, fetchOptions);

      // Handle response status
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      // Parse response based on format
      let result: T;
      switch (responseFormat) {
        case 'json':
          result = await response.json() as T;
          break;
        case 'text':
          result = await response.text() as unknown as T;
          break;
        case 'binary':
          result = await response.arrayBuffer() as unknown as T;
          break;
        default:
          result = await response.json() as T;
      }

      return result;
    } finally {
      clearTimeout(timeoutId);
      this.controller = null;
    }
  }

  /**
   * Open a stream to the MCP server using Server-Sent Events
   * @param url Stream URL
   * @param options Request options
   * @returns AsyncGenerator yielding stream events
   */
  async *openStream(url: string, options: RequestOptions = {}): AsyncGenerator<any, void, unknown> {
    const {
      headers = {},
      timeout = this.options.defaultTimeout
    } = options;

    // Create abort controller for timeout handling
    this.controller = new AbortController();
    const { signal } = this.controller;

    // Set up timeout
    let timeoutId = setTimeout(() => {
      this.controller?.abort();
    }, timeout);

    try {
      // Prepare headers
      const mergedHeaders: Record<string, string> = {
        ...this.options.defaultHeaders,
        ...headers,
        'Accept': 'text/event-stream'
      };

      // Send request
      const response = await fetch(url, {
        headers: mergedHeaders,
        signal
      });

      // Handle response status
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      // Ensure we have a readable stream
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete events in buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep the last incomplete event in the buffer

        for (const event of events) {
          if (!event.trim()) continue;

          // Parse event data
          const lines = event.split('\n');
          const dataLine = lines.find(line => line.startsWith('data: '));

          if (dataLine) {
            const data = dataLine.substring(6);
            try {
              const parsedData = JSON.parse(data);

              // If this is a JSON-RPC message and we have an onmessage callback
              // from the MCP Transport interface, call it
              if (this.onmessage &&
                  (parsedData.jsonrpc === '2.0' ||
                   parsedData.id !== undefined ||
                   parsedData.method !== undefined ||
                   parsedData.result !== undefined ||
                   parsedData.error !== undefined)) {
                this.onmessage(parsedData as JSONRPCMessage);
              }

              yield parsedData;

              // Reset timeout on each event
              clearTimeout(timeoutId);
              timeoutId = setTimeout(() => {
                this.controller?.abort();
              }, timeout);
            } catch (e) {
              // If not JSON, yield raw data
              yield data;
            }
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      this.controller = null;
    }
  }

  /**
   * Close the transport and abort any pending requests
   * This is a required method from both the TransportAdapter and MCP Transport interfaces
   */
  async close(): Promise<void> {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }

    // Call the onclose callback if it exists
    if (this.onclose) {
      this.onclose();
    }
  }
}
