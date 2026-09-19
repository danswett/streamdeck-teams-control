/**
 * Composes the PowerPoint Live drawing-tool artwork at a given size.
 *
 * Shared by the two build steps that need it: tools/build-tool-images.ts, which
 * pre-renders every color for the live keys, and tools/generate-icons.ts,
 * which writes the static manifest artwork. Keeping one composer means the
 * action list cannot drift from what the key draws.
 *
 * The artwork itself is Microsoft's, captured from the Teams DOM into
 * src/tool-icons.json - gradients, blur filters and blend modes included.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type ToolIcon = { viewBox: string; body: string; rootFill: string };

export const TOOL_ICONS: Record<string, ToolIcon> = JSON.parse(
	readFileSync(path.join(ROOT, "src", "tool-icons.json"), "utf8")
).tools;

/** Fraction of the canvas the artwork fills, leaving room for the selection bar. */
const FILL = 0.86;

/** Teams marks the tool in use with a bar beneath it, in its accent color. */
const SELECTION_BAR = "#5B5FC7";

export function composeToolSvg(
	icon: ToolIcon,
	ink: string,
	active: boolean,
	size: number
): string {
	const [minX, minY, w, h] = icon.viewBox.split(/\s+/).map(Number);
	const extent = Math.max(w, h);
	const scale = (size * FILL) / extent;
	const offsetX = (size - w * scale) / 2 - minX * scale;
	const offsetY = (size - h * scale) / 2 - minY * scale;

	// The captured <svg> carried fill="none", and it matters: several paths are
	// stroke-only, and without it they fall back to SVG's default black fill and
	// paint over the tool's tip.
	const art =
		`<g fill="${icon.rootFill}" transform="translate(${offsetX.toFixed(3)} ${offsetY.toFixed(3)}) ` +
		`scale(${scale.toFixed(5)})">${icon.body.replaceAll("{ink}", ink)}</g>`;

	const barWidth = size * 0.34;
	const bar = active
		? `<rect x="${(size - barWidth) / 2}" y="${size - size * 0.111}" width="${barWidth}" ` +
			`height="${size * 0.049}" rx="${size * 0.024}" fill="${SELECTION_BAR}"/>`
		: "";

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
		`viewBox="0 0 ${size} ${size}">${art}${bar}</svg>`
	);
}
