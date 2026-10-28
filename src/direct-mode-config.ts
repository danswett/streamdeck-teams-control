import { homedir } from "node:os";
import path from "node:path";

/** Keep user consent outside the checksum-protected package, isolated by plugin UUID. */
export function directModeConfigPath(
	pluginDirectory: string,
	platform: NodeJS.Platform = process.platform,
	localAppData: string = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
): string | undefined {
	if (platform !== "win32") return undefined;
	const uuid = path.win32.basename(pluginDirectory).replace(/\.sdPlugin$/i, "");
	return path.win32.join(localAppData, uuid, "direct-mode.json");
}
