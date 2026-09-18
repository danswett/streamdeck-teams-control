/*
 * Paste this into the Teams DevTools console while a deck is being presented.
 *
 * It grabs the real artwork for every toolbar button straight from the DOM,
 * which is the only way to be sure a key matches its counterpart: the glyphs
 * are picked from Fluent by name, and several of Fluent's defaults are drawn at
 * a different orientation or weight than the one Teams actually renders.
 *
 * Teams splits a meeting across frames - the slide-show toolbar and the meeting
 * toolbar carrying "Stop sharing" are not in the same document - so this walks
 * every same-origin frame rather than the top one only, and records which frame
 * each button came from. A top-frame-only query silently misses half of them.
 *
 * Hover the slide first so the toolbars are mounted, and open any flyout whose
 * items you want included. The result goes on the clipboard.
 */
copy(
	JSON.stringify(
		(() => {
			const docs = [];
			const visit = (win, path) => {
				let doc;
				try {
					doc = win.document;
				} catch {
					return; // cross-origin: nothing readable here
				}
				docs.push({ doc, path });
				[...doc.querySelectorAll("iframe, frame")].forEach((f, i) => {
					try {
						if (f.contentWindow) visit(f.contentWindow, path + "/" + (f.id || f.name || i));
					} catch {
						/* cross-origin */
					}
				});
			};
			visit(window.top || window, "top");

			const out = [];
			for (const entry of docs) {
				const sel =
					"button, [role='button'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='tab']";
				for (const b of entry.doc.querySelectorAll(sel)) {
					const svg = b.querySelector("svg");
					if (!svg) continue;
					const label =
						b.getAttribute("aria-label") || b.getAttribute("title") || (b.textContent || "").trim();
					if (!label && !b.id) continue;
					out.push({
						frame: entry.path,
						id: b.id || null,
						label: label,
						pressed: b.getAttribute("aria-pressed") || b.getAttribute("aria-checked") || null,
						svg: svg.outerHTML
					});
				}
			}
			return out;
		})(),
		null,
		1
	)
);