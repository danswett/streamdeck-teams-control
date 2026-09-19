/*
 * The product mark: four keys on an indigo tile.
 *
 * Shared because it is used in two places that must not disagree - the plugin
 * icon Stream Deck shows in its preferences, and the 288px app icon on the
 * Marketplace listing. They were drawn separately once, and drifted: the store
 * showed the four keys while Stream Deck still showed a lone microphone from
 * when the plugin only did meetings.
 *
 * Every key is drawn by the functions the plugin itself uses, so the mark
 * cannot show artwork the product does not ship.
 */
import { renderEmoji, renderToggle, renderTool } from "../src/icons.ts";

/** Drawn on a 288 viewBox; callers rasterise it at whatever size they need. */
const S = 288;

const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

const tool = (control: string): string => {
	const art = renderTool(control, { available: true, active: true });
	if (!art.startsWith("data:")) return art;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><image href="${art}" x="0" y="0" width="144" height="144"/></svg>`;
};

export function appIconSvg(): string {
	const pad = 30;
	const gap = 16;
	const cell = (S - pad * 2 - gap) / 2;

	// Mute and camera show their "off" artwork, which is the state a key is in
	// more often and the one that reads at a glance. The fourth is a drawing
	// tool rather than a reaction: PowerPoint Live is half the product, and
	// nothing else in the set hints at it. The pen survives being shrunk to a
	// search result, where a laser's thin shape and a slide counter's text do
	// not.
	const art = [
		renderToggle({ onKey: "micOff", offKey: "mic", onTone: "on", offTone: "on", active: true, available: true }),
		renderToggle({ onKey: "camera", offKey: "cameraOff", onTone: "on", offTone: "on", active: false, available: true }),
		renderEmoji("hand", true),
		tool("ppt-pen")
	];

	let body = `<rect width="${S}" height="${S}" rx="64" fill="#5059C9"/>`;
	art.forEach((svg, i) => {
		const x = pad + (i % 2) * (cell + gap);
		const y = pad + Math.floor(i / 2) * (cell + gap);
		body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${cell * 0.16}" fill="#1A1A1D"/>`;
		body += `<g transform="translate(${x},${y}) scale(${cell / 144})">${inner(svg)}</g>`;
	});

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>`;
}
