/*
 * Paste this into the Teams DevTools console while a deck is being presented.
 *
 * It grabs the real drawing-tool SVGs straight from the DOM - gradients,
 * filters and all - plus each tool's title, which is where Teams records the
 * ink colour. The result goes on the clipboard.
 */
copy(
	JSON.stringify(
		[...document.querySelectorAll('[id^="ink-tool-"]')].map((b) => ({
			id: b.id,
			title: b.getAttribute("title") || b.getAttribute("aria-label") || "",
			selected: b.getAttribute("aria-selected"),
			svg: b.querySelector("svg")?.outerHTML ?? null
		})),
		null,
		1
	)
);
