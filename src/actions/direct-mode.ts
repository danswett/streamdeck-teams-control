import streamDeck, {
	action, SingletonAction, type KeyAction, type KeyDownEvent, type SendToPluginEvent,
	type WillAppearEvent, type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { directModeControl } from "../direct-mode";
import { renderDirectMode, toDataUri } from "../icons";

const UUID = "com.bad-duck.teamscontrol.direct-mode";
const logger = streamDeck.logger.createScope("DirectModeAction");

@action({ UUID: "com.bad-duck.teamscontrol.direct-mode" })
export class DirectModeAction extends SingletonAction {
	#unsubscribe: (() => void) | undefined;
	#visible = 0;
	#painted = new Map<string, string>();

	override onWillAppear(ev: WillAppearEvent): void {
		this.#visible++;
		this.#unsubscribe ??= directModeControl.subscribe(() => {
			for (const key of this.actions) if (key.isKey()) void this.#paint(key);
			void this.#inspector();
		});
		if (ev.action.isKey()) void this.#paint(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#painted.delete(ev.action.id);
		this.#visible = Math.max(0, this.#visible - 1);
		if (!this.#visible) {
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
		}
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const result = await directModeControl.toggle();
		if (!result.ok) await ev.action.showAlert();
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const payload = ev.payload;
		if (typeof payload !== "object" || payload === null || !("event" in payload)) return;
		let result: { ok: boolean; error?: string } = { ok: true };
		if (payload.event === "direct-mode-port") {
			if (!("port" in payload) || typeof payload.port !== "number") {
				result = { ok: false, error: "Port must be a whole number between 1 and 65535" };
			} else result = await directModeControl.setPort(payload.port);
		} else if (payload.event === "direct-mode-toggle") result = await directModeControl.toggle();
		else if (payload.event === "direct-mode-status") result = await directModeControl.refresh();
		else return;
		if (streamDeck.ui.action?.id === ev.action.id) await this.#inspector(result.error);
	}

	async #inspector(error?: string): Promise<void> {
		if (streamDeck.ui.action?.manifestId !== UUID) return;
		try {
			await streamDeck.ui.sendToPropertyInspector({
				event: "direct-mode-status", ...directModeControl.status,
				error: error ?? directModeControl.status.error ?? ""
			});
		} catch (err) { logger.warn(`Could not update Direct mode inspector: ${String(err)}`); }
	}

	async #paint(key: KeyAction): Promise<void> {
		const status = directModeControl.status;
		const image = toDataUri(renderDirectMode(status.enabled, status.usable, status.supported));
		if (this.#painted.get(key.id) === image) return;
		this.#painted.set(key.id, image);
		try { await key.setImage(image); }
		catch (err) {
			this.#painted.delete(key.id);
			logger.warn(`Could not draw Direct mode key: ${String(err)}`);
		}
	}
}
