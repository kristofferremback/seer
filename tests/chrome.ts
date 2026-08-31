import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class CdpConnection {
  private id = 0;
  private pending = new Map<number, Pending>();
  private waiters: { method: string; sessionId?: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }[] = [];

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.method !== message.method || waiter.sessionId !== message.sessionId) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message.params);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Chrome DevTools connection closed")); }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome DevTools WebSocket did not open")), 5_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome DevTools WebSocket failed")); }, { once: true });
    });
    return new CdpConnection(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out sending Chrome command ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  event(method: string, sessionId?: string, timeout = 5_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for Chrome event ${method}`));
      }, timeout) };
      this.waiters.push(waiter);
    });
  }

  close(): void { this.socket.close(); }
}

export interface ChromeLaunchOptions {
  width: number;
  height?: number;
  dark?: boolean;
  touch?: boolean;
  javascript?: boolean;
  profileRoot: string;
  name: string;
}

export class ChromePage {
  readonly pid: number;
  private constructor(
    private process: ReturnType<typeof Bun.spawn>,
    private cdp: CdpConnection,
    private sessionId: string | undefined,
    private profile: string,
  ) {
    this.pid = process.pid;
  }

  static async launch(options: ChromeLaunchOptions): Promise<ChromePage> {
    const profile = join(options.profileRoot, `${options.name}-profile`);
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true });
    if (options.javascript === false) {
      mkdirSync(join(profile, "Default"), { recursive: true });
      await Bun.write(join(profile, "Default", "Preferences"), JSON.stringify({ profile: { default_content_setting_values: { javascript: 2 } } }));
    }
    const process = Bun.spawn([
      "/usr/bin/google-chrome",
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-extensions",
      "--no-proxy-server",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      `--window-size=${options.width},${options.height ?? 1000}`,
      "about:blank",
    ], { stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: profile } });
    let stderr = "";
    let websocket = "";
    const reader = process.stderr.getReader();
    const deadline = Date.now() + 8_000;
    while (!websocket && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Chrome DevTools endpoint timed out")), remaining)),
      ]);
      if (result.done) break;
      stderr += new TextDecoder().decode(result.value);
      websocket = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1] ?? "";
    }
    if (!websocket) {
      process.kill("SIGKILL");
      throw new Error(`Chrome ${process.pid} did not publish a DevTools endpoint: ${stderr.slice(-500)}`);
    }
    // Chrome can block when its stderr pipe fills. Keep draining after the endpoint line.
    void (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })();
    const origin = websocket.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
    const target = await fetch(`${origin}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
    const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    const sessionId = undefined;
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId),
      cdp.send("DOM.enable", {}, sessionId),
      cdp.send("Emulation.setDeviceMetricsOverride", { width: options.width, height: options.height ?? 1000, deviceScaleFactor: 1, mobile: options.width <= 500, screenWidth: options.width, screenHeight: options.height ?? 1000 }, sessionId),
      cdp.send("Emulation.setTouchEmulationEnabled", { enabled: options.touch === true, maxTouchPoints: options.touch ? 5 : 1 }, sessionId),
      cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: options.dark ? "dark" : "light" }] }, sessionId),
    ]);
    return new ChromePage(process, cdp, sessionId, profile);
  }

  async navigate(url: string): Promise<void> {
    const wanted = new URL(url).href;
    const loaded = this.cdp.event("Page.loadEventFired", this.sessionId, 10_000);
    await this.cdp.send("Page.navigate", { url: wanted }, this.sessionId);
    await loaded;
    await this.waitFor(`document.readyState==='complete' && location.href===${JSON.stringify(wanted)}`, 2_000);
  }

  async reload(url?: string): Promise<void> {
    const loaded = this.cdp.event("Page.loadEventFired", this.sessionId, 10_000);
    const target = url ? JSON.stringify(new URL(url).href) : "location.href";
    await this.evaluate(`(history.replaceState(history.state,'',${target}),setTimeout(()=>location.reload(),0),true)`);
    await loaded;
    await this.waitFor("document.readyState==='complete'", 2_000);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Chrome evaluation failed");
    return result.result.value as T;
  }

  async waitFor(expression: string, timeout = 8_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(25);
    }
    throw new Error(`Chrome did not satisfy: ${expression}`);
  }

  private async point(selector: string, index = 0): Promise<{ x: number; y: number }> {
    const point = await this.evaluate<{ x: number; y: number } | null>(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!point) throw new Error(`Chrome could not find ${selector}[${index}]`);
    return point;
  }

  async click(selector: string, index = 0): Promise<void> {
    const { x, y } = await this.point(selector, index);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, this.sessionId);
  }

  async drag(fromSelector: string, fromIndex: number, toSelector: string, toIndex: number): Promise<void> {
    const points = await this.evaluate<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(()=>{const from=document.querySelectorAll(${JSON.stringify(fromSelector)})[${fromIndex}],to=document.querySelectorAll(${JSON.stringify(toSelector)})[${toIndex}];if(!from||!to)throw new Error('missing drag control');from.scrollIntoView({block:'center',inline:'center'});const a=from.getBoundingClientRect(),b=to.getBoundingClientRect();return{from:{x:a.left+a.width/2,y:a.top+a.height/2},to:{x:b.left+b.width/2,y:b.top+b.height/2}}})()`);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...points.from }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...points.from, button: "left", buttons: 1, clickCount: 1 }, this.sessionId);
    for (let step = 1; step <= 5; step++) {
      const ratio = step / 5;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: points.from.x + (points.to.x - points.from.x) * ratio, y: points.from.y + (points.to.y - points.from.y) * ratio, button: "left", buttons: 1 }, this.sessionId);
    }
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...points.to, button: "left", buttons: 0, clickCount: 1 }, this.sessionId);
  }

  async touch(selector: string, index = 0): Promise<void> {
    const point = await this.point(selector, index);
    const touch = { x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1, id: 1 };
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] }, this.sessionId);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, this.sessionId);
  }

  async key(key: string, modifiers = 0): Promise<void> {
    const keyCode = key === "Enter" ? 13 : key === "Escape" ? 27 : 0;
    const text = key === "Enter" ? "\r" : "";
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }, this.sessionId);
  }

  async type(selector: string, text: string, index = 0): Promise<void> {
    await this.click(selector, index);
    await this.cdp.send("Input.insertText", { text }, this.sessionId);
  }

  async setValue(selector: string, value: string, index = 0): Promise<void> {
    await this.evaluate(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!el)throw new Error('missing field');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  }

  async clickAndWaitForLoad(selector: string, index = 0): Promise<void> {
    await this.click(selector, index);
    // Local POST + 303/reload completes well below this. The caller then asserts the new
    // DOM and stored row, so a fragment-only navigation or failed submit still fails.
    await Bun.sleep(750);
    await this.waitFor("document.readyState==='complete'", 2_000);
  }

  async activateAndWaitForLoad(selector: string, index = 0): Promise<void> {
    await this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].click()`);
    await Bun.sleep(750);
    await this.waitFor("document.readyState==='complete'", 2_000);
  }

  async screenshot(path: string): Promise<void> {
    const result = await this.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, this.sessionId);
    await Bun.write(path, Buffer.from(result.data, "base64"));
  }

  async close(): Promise<void> {
    this.cdp.close();
    this.process.kill("SIGKILL");
    const exited = await Promise.race([this.process.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) throw new Error(`Chrome PID ${this.pid} did not exit after SIGKILL`);
    rmSync(this.profile, { recursive: true, force: true });
  }
}
