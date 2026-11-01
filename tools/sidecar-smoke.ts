/**
 * Starts a real sidecar binary and checks it answers the protocol, with no
 * Teams running.
 *
 * The unit tests cover the rules inside each sidecar; nothing covered the
 * binary itself - that it starts, says it is ready, answers every command the
 * plugin sends in the shape the plugin parses, and exits when told. A sidecar
 * that crashed on launch, or renamed a reply field, passed every test and
 * showed up as every key sitting dimmed on a tester's machine. This is run in
 * CI against the freshly built binary on its own platform, and again on macOS
 * against the binary unpacked from the final .streamDeckPlugin.
 *
 * Nothing here needs Teams, a meeting or any permission: every answer checked
 * is the one a sidecar gives when Teams is absent.
 *
 * Run with: node tools/sidecar-smoke.ts <path to sidecar binary> [--selectors <file>]
 */
import { spawn } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Message = Record<string, unknown>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const binary = args[0];
if (!binary) {
	console.error("usage: node tools/sidecar-smoke.ts <sidecar binary> [--selectors <file>]");
	process.exit(2);
}
const selectorsAt = args.indexOf("--selectors");
const selectors = selectorsAt >= 0
	? args[selectorsAt + 1]
	: path.join(ROOT, "com.bad-duck.teamscontrol.sdPlugin", "selectors.json");
const mac = process.platform === "darwin";

// A packed sidecar arrives without its execute bit (#7); the plugin restores
// it before spawning, and so does this.
if (!mac || (statSync(binary).mode & 0o111) === 0) {
	try { chmodSync(binary, 0o755); } catch { /* Windows has no execute bit to set */ }
}

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
	console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
	if (!ok) failures.push(what);
};

const child = spawn(binary, ["--selectors", selectors, ...(mac ? [] : ["--direct-mode-managed"])], {
	stdio: ["pipe", "pipe", "pipe"]
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => { stderr += chunk; });

const messages: Message[] = [];
const waiters: { match: (m: Message) => boolean; resolve: (m: Message | undefined) => void }[] = [];
let buffer = "";
let unparsable = 0;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
	buffer += chunk;
	let at: number;
	while ((at = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, at).trim();
		buffer = buffer.slice(at + 1);
		if (!line) continue;
		let msg: Message;
		try { msg = JSON.parse(line) as Message; }
		catch { unparsable++; continue; }
		messages.push(msg);
		for (const w of [...waiters]) {
			if (w.match(msg)) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(msg);
			}
		}
	}
});

function next(match: (m: Message) => boolean, timeoutMs = 30_000): Promise<Message | undefined> {
	const seen = messages.find(match);
	if (seen) return Promise.resolve(seen);
	return new Promise((resolve) => {
		const waiter = { match, resolve };
		waiters.push(waiter);
		setTimeout(() => {
			const i = waiters.indexOf(waiter);
			if (i >= 0) { waiters.splice(i, 1); resolve(undefined); }
		}, timeoutMs);
	});
}

let nextId = 1;
async function ask(cmd: Message, type: string, timeoutMs?: number): Promise<Message | undefined> {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
	return next((m) => m["type"] === type && m["id"] === id, timeoutMs);
}

const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

async function run(): Promise<void> {
	const ready = await next((m) => m["type"] === "ready", 30_000);
	check(ready !== undefined && typeof ready["pid"] === "number", "starts and announces ready with its pid");
	if (!ready) return;
	if (mac) check(ready["platform"] === "macos", "identifies itself as the macOS sidecar");

	const ping = await ask({ cmd: "ping" }, "result");
	check(ping?.["ok"] === true, "answers ping");

	const status = await ask({ cmd: "status" }, "result");
	const state = messages.filter((m) => m["type"] === "state").at(-1);
	check(status?.["ok"] === true, "answers status");
	check(state !== undefined && typeof state["teamsRunning"] === "boolean" && typeof state["inMeeting"] === "boolean"
		&& typeof state["states"] === "object" && typeof state["available"] === "object"
		&& typeof state["context"] === "object", "publishes a well-formed state");

	// Harmless even on a machine that is in a meeting: a slide number that is
	// not a number is refused before anything is looked for, on both sidecars.
	const press = await ask({ cmd: "invoke", target: "ppt-goto-slide", arg: "not-a-number" }, "result");
	check(press?.["ok"] === false && typeof press["error"] === "string", "refuses an invalid press, saying why");

	const unknown = await ask({ cmd: "invoke", target: "no-such-control", arg: "" }, "result");
	check(unknown?.["ok"] === false, "refuses an unknown target");

	const cameras = await ask({ cmd: "cameras" }, "cameras");
	const list = cameras?.["cameras"];
	check(cameras !== undefined && (cameras["ok"] === false || (Array.isArray(list) && list.every((c) =>
		typeof c === "object" && c !== null && typeof (c as Message)["id"] === "string"
		&& typeof (c as Message)["name"] === "string"))), "answers cameras with a list the plugin accepts");

	const thumb = await ask({ cmd: "thumb", arg: "next", fade: 99, w: 99_999, h: 1 }, "thumb");
	check(thumb?.["ok"] === false && thumb["which"] === "next" && typeof thumb["end"] === "boolean",
		"answers a thumbnail request in the thumb shape, even out of range");

	const forgetId = nextId++;
	child.stdin.write(`${JSON.stringify({ id: forgetId, cmd: "forget", arg: "current" })}\n`);

	const direct = await ask({ cmd: "directmode" }, "directmode");
	check(direct?.["ok"] === true && typeof direct["usable"] === "boolean" && typeof direct["reason"] === "string",
		"answers the Direct mode probe");

	if (mac) {
		const permissions = await ask({ cmd: "permissions" }, "permissions");
		check(permissions?.["ok"] === true && typeof permissions["accessibility"] === "boolean"
			&& typeof permissions["screenRecording"] === "boolean", "reports permission state without prompting");
	}

	const bogus = await ask({ cmd: "no-such-command" }, "result");
	check(bogus?.["ok"] === false, "names an unknown command rather than ignoring it");

	check(unparsable === 0, "writes nothing but JSON lines to stdout");
	check(!messages.some((m) => m["id"] === forgetId), "never answers forget");

	child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
	const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
	check(code === 0, `exits cleanly on shutdown (exit ${String(code)})`);
}

try {
	await run();
} finally {
	if (child.exitCode === null) child.kill();
}

if (failures.length) {
	const seen = messages.map((m) => `${String(m["type"])}#${String(m["id"] ?? "-")}`).join(" ");
	console.log(`\n${failures.length} check(s) failed.\nMessages: ${seen}\nSidecar stderr:\n${stderr}`);
	process.exit(1);
}
console.log("\nsidecar smoke test passed");
