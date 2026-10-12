// Independent wire observer. No product client methods or private object access.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export class WireClient {
  constructor(url, clientId = randomUUID(), modern = true) {
    this.url = url;
    this.clientId = clientId;
    this.modern = modern;
    this.socket = null;
    this.frames = [];
    this.waiters = new Set();
  }
  async connect() {
    const socket = new WebSocket(this.url, { maxPayload: 1024 * 1024 });
    this.socket = socket;
    socket.on("message", (bytes) => {
      let frame;
      try {
        frame = JSON.parse(bytes.toString());
      } catch (error) {
        this.reject(error);
        return;
      }
      if (this.frames.length >= 512) this.frames.shift();
      this.frames.push(frame);
      for (const waiter of this.waiters) {
        if (waiter.matches(frame)) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      }
    });
    socket.on("error", (error) => this.reject(error));
    socket.on("close", () => this.reject(new Error("Wire observer disconnected")));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: this.clientId,
        clientType: "browser",
        protocolVersion: 1,
        appVersion: "0.10.3",
        capabilities: this.modern
          ? { owned_subscriptions: true, explicit_event_subscriptions: true, all_providers: true }
          : {},
      }),
    );
    const ready = await this.wait(
      (frame) =>
        frame.type === "session" &&
        frame.message?.type === "status" &&
        frame.message.payload?.status === "server_info",
    );
    return ready.message.payload;
  }
  reject(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
  wait(matches, timeout = 15000, after = 0) {
    const existing = this.frames.slice(after).find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("Wire observer deadline"));
      }, timeout);
      this.waiters.add(waiter);
    });
  }
  request(type, payload) {
    const requestId = randomUUID();
    const answer = this.wait(
      (frame) => frame.type === "session" && frame.message?.payload?.requestId === requestId,
    );
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("Wire observer is not connected");
    this.socket.send(JSON.stringify({ type: "session", message: { type, requestId, ...payload } }));
    return answer.then((frame) => frame.message);
  }
  async close() {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
  }
}
