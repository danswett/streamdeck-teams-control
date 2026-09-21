/**
 * The decks the plugin ships a layout for, and the shape of each one.
 *
 * Kept apart from tools/build-profile.ts because more than one tool needs it:
 * the builder places keys against these grids, and tools/preview-profiles.ts
 * draws the result at the right size. A profile does not record the grid it
 * was built for, so a second copy of these numbers would be a second thing to
 * get wrong.
 *
 * Every deck here has a grid that is fixed and published. The ones missing
 * have neither: the Pedal publishes no key layout, and Stream Deck Mobile and
 * the Virtual deck are whatever size the user makes them.
 *
 * The Studio is left out for a different reason. Its grid is published and a
 * layout for it worked, but it is a rack-mounted broadcast deck - the odds of
 * one sitting in front of somebody running a Teams meeting are slim enough
 * that three more profiles were not worth carrying.
 */

export type Deck = {
	/** Value for the manifest's `Profiles[].DeviceType`. */
	deviceType: number;
	/**
	 * `Device.Model` as shipped in the profile, which Stream Deck ignores.
	 *
	 * It looked like the field that binds a profile to a deck, and it is not.
	 * Installing a profile that deliberately carried "ZZTESTMODEL" onto a
	 * 15-key wrote `Model: 20GBA9901` and that deck's own USB identity into
	 * the installed copy: Stream Deck overwrites whatever is here with the
	 * device it is actually installing onto. What selects the deck is the
	 * manifest's `Profiles[].DeviceType` together with the device passed to
	 * switchToProfile.
	 *
	 * So a deck with no published model code ships an empty one rather than a
	 * guess. The two codes below are kept only because they are already baked
	 * into published layout fingerprints, and changing a fingerprint costs
	 * every user a duplicate profile.
	 */
	model: string;
	columns: number;
	rows: number;
	/** Dials, which need a second controller in every page. Zero if it has none. */
	encoders: number;
	/**
	 * Width of the touch strip in pixels, or 0 for a deck whose dials have no
	 * screen behind them.
	 *
	 * Every strip gives a dial the same 200x100 canvas - the + spreads 800px
	 * across four dials and the + XL 1200px across six - which is why one set
	 * of dial artwork serves both.
	 */
	stripWidth: number;
	/**
	 * Appended to the profile and file name so one plugin can ship a layout
	 * per deck. Empty for the 15-key, whose files shipped before there was a
	 * second device and must keep the names Stream Deck already installed.
	 */
	suffix: string;
	/** What to call the deck in documentation. */
	label: string;
};

/** Stream Deck MK.2 / standard 15-key. Manifest DeviceType 0. */
export const STREAM_DECK: Deck = {
	deviceType: 0,
	model: "20GBA9901",
	columns: 5,
	rows: 3,
	encoders: 0,
	stripWidth: 0,
	suffix: "",
	label: "Stream Deck",
	slug: "stream-deck"
};

/** Stream Deck Mini: 6 keys in a 3x2 grid. Manifest DeviceType 1. */
export const MINI: Deck = {
	deviceType: 1,
	model: "",
	columns: 3,
	rows: 2,
	encoders: 0,
	stripWidth: 0,
	suffix: " (Mini)",
	label: "Stream Deck Mini",
	slug: "mini"
};

/** Stream Deck XL: 32 keys in an 8x4 grid. Manifest DeviceType 2. */
export const XL: Deck = {
	deviceType: 2,
	model: "",
	columns: 8,
	rows: 4,
	encoders: 0,
	stripWidth: 0,
	suffix: " (XL)",
	label: "Stream Deck XL",
	slug: "xl"
};

/** Stream Deck +: 8 keys in a 4x2 grid, four dials and a touch strip. DeviceType 7. */
export const PLUS: Deck = {
	deviceType: 7,
	model: "",
	columns: 4,
	rows: 2,
	encoders: 4,
	stripWidth: 800,
	suffix: " (+)",
	label: "Stream Deck +",
	slug: "plus"
};

/**
 * Stream Deck Neo: 8 keys in a 4x2 grid. Manifest DeviceType 9.
 *
 * It has a window and two touch sensors, and neither is a slot a profile can
 * fill: the window is informational, and the sensors are wired to page
 * navigation. So it is the + without the dials.
 */
export const NEO: Deck = {
	deviceType: 9,
	model: "20GBJ9901",
	columns: 4,
	rows: 2,
	encoders: 0,
	stripWidth: 0,
	suffix: " (Neo)",
	label: "Stream Deck Neo",
	slug: "neo"
};

/** Stream Deck + XL: 36 keys in a 9x4 grid, plus six dials. Manifest DeviceType 13. */
export const PLUS_XL: Deck = {
	deviceType: 13,
	model: "20GBX9901",
	columns: 9,
	rows: 4,
	encoders: 6,
	stripWidth: 1200,
	suffix: " (+ XL)",
	label: "Stream Deck + XL",
	slug: "plus-xl"
};

/** Every deck with a bundled layout, smallest grid first. */
export const DECKS: Deck[] = [MINI, STREAM_DECK, PLUS, NEO, XL, PLUS_XL];
