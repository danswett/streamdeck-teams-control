/*
 * Paste this into the Teams DevTools console while a deck is being presented,
 * with the slide-show toolbar showing (hover the slide first - Teams unmounts
 * the toolbar when the pointer leaves it).
 *
 * It grabs the real artwork for every toolbar button straight from the DOM,
 * which is the only way to be sure a key matches its counterpart: the glyphs
 * are picked from Fluent by name, and several of Fluent's defaults are drawn at
 * a different orientation or weight than the one Teams actually renders.
 *
 * The result goes on the clipboard.
 */
copy(
	JSON.stringify(
		[...document.querySelectorAll("button, [role='button'], [role='menuitemcheckbox'], [role='tab']")]
			.map((b) => {
				const svg = b.querySelector("svg");
				if (!svg) return null;
				const label =
					b.getAttribute("aria-label") ||
					b.getAttribute("title") ||
					b.textContent?.trim() ||
					"";
				// Unlabelled decorative buttons are noise; everything the plugin
				// drives has one.
				if (!label && !b.id) return null;
				return {
					id: b.id || null,
					label,
					pressed: b.getAttribute("aria-pressed") ?? b.getAttribute("aria-checked") ?? null,
					box: (() => {
						const r = svg.getBoundingClientRect();
						return { w: Math.round(r.width), h: Math.round(r.height) };
					})(),
					svg: svg.outerHTML
				};
			})
			.filter(Boolean),
		null,
		1
	)
);
