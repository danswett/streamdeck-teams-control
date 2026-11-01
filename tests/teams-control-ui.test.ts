import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it, vi } from "vitest";

const root = path.resolve(__dirname, "..", "com.bad-duck.teamscontrol.sdPlugin", "ui");
const pages = ["camera-select", "default", "direct-mode", "leave", "ppt", "ppt-stop", "slide-counter", "slide-thumb"];

type Element = {
	textContent: string; checked: boolean; disabled: boolean; hidden: boolean;
	handlers: Map<string, () => Promise<void>>;
	addEventListener: (event: string, handler: () => Promise<void>) => void;
};

async function inspector(page: string) {
	const elements = new Map<string, Element>();
	let script: string | undefined;
	function visit(node: DefaultTreeAdapterTypes.Node): void {
		if ("attrs" in node) {
			const id = node.attrs.find((a) => a.name === "id")?.value;
			if (id) {
				const handlers = new Map<string, () => Promise<void>>();
				elements.set(id, {
					textContent: "", checked: false, disabled: true,
					hidden: node.attrs.some((a) => a.name === "hidden"), handlers,
					addEventListener: (event, handler) => { handlers.set(event, handler); }
				});
			}
			if (node.tagName === "script" && node.attrs.some((a) => a.name === "src" && a.value === "teams-control-settings.js"))
				script = readFileSync(path.join(root, "teams-control-settings.js"), "utf8");
		}
		if ("childNodes" in node) node.childNodes.forEach(visit);
	}
	visit(parse(readFileSync(path.join(root, `${page}.html`), "utf8")));
	if (!script) throw new Error(`Missing Teams control script in ${page}`);

	let receive: (event: { payload: Record<string, unknown> }) => void = () => {};
	const send = vi.fn().mockResolvedValue(undefined);
	vm.runInNewContext(script, {
		document: { getElementById: (id: string) => elements.get(id) },
		SDPIComponents: { streamDeckClient: {
			getConnectionInfo: vi.fn().mockResolvedValue({}), send,
			sendToPropertyInspector: { subscribe: (fn: typeof receive) => { receive = fn; } }
		} }
	});
	await Promise.resolve();
	await Promise.resolve();
	const section = elements.get("teams-control")!;
	const box = elements.get("teams-control-enabled")!;
	const status = elements.get("teams-control-status")!;
	const update = (payload: Record<string, unknown>) =>
		receive({ payload: { event: "teams-control-status", supported: true, loaded: true, busy: false, ...payload } });
	return { section, box, status, send, update };
}

describe("Teams control setting in every key's settings", () => {
	it.each(pages)("is hidden off a Mac and offered on one, in %s", async (page) => {
		const ui = await inspector(page);
		expect(ui.section.hidden).toBe(true);
		expect(ui.send).toHaveBeenCalledWith("sendToPlugin", { event: "teams-control-status" });
		ui.update({ supported: false });
		expect(ui.section.hidden).toBe(true);
		ui.update({ enabled: undefined });
		expect(ui.section.hidden).toBe(false);
		expect(ui.box.checked).toBe(false);
		expect(ui.box.disabled).toBe(false);
		expect(ui.status.textContent).toContain("do nothing until this is on");
	});

	it("sends the user's choice and reports what macOS still needs", async () => {
		const ui = await inspector("default");
		ui.update({ enabled: false });
		ui.box.checked = true;
		await ui.box.handlers.get("change")?.();
		expect(ui.box.disabled).toBe(true);
		expect(ui.send).toHaveBeenLastCalledWith("sendToPlugin", { event: "teams-control-set", enabled: true });
		ui.update({ enabled: true, accessibility: false });
		expect(ui.status.textContent).toContain("Privacy & Security > Accessibility");
		ui.update({ enabled: true, accessibility: true });
		expect(ui.status.textContent).toContain("has Accessibility permission");
		ui.update({ enabled: true, error: "Could not save" });
		expect(ui.status.textContent).toBe("Could not save");
	});

	it("names Screen Recording as a separate, slide-dial-only permission", () => {
		const thumb = readFileSync(path.join(root, "slide-thumb.html"), "utf8");
		expect(thumb).toMatch(/Screen\s+Recording/);
		expect(thumb).toMatch(/separately from Teams control/);
	});
});
