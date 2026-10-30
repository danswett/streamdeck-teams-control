import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

let writes: Promise<unknown> = Promise.resolve();

export async function getGlobalSettings(): Promise<JsonObject> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			streamDeck.settings.getGlobalSettings(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Stream Deck settings request timed out")), 10_000);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function updateGlobalSettings(change: (settings: JsonObject) => JsonObject): Promise<JsonObject> {
	const write = writes.then(async () => {
		const next = change(await getGlobalSettings());
		await streamDeck.settings.setGlobalSettings(next);
		return next;
	});
	// Keep later changes runnable without hiding this change's rejection from its caller.
	writes = write.catch(() => undefined);
	return write;
}
