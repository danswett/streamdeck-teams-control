(() => {
	const client = SDPIComponents.streamDeckClient;
	const select = document.getElementById("language-select");
	const status = document.getElementById("language-status");
	async function send(payload) {
		try {
			await client.send("sendToPlugin", payload);
		} catch (error) {
			select.disabled = false;
			status.textContent = `Could not contact the plugin: ${String(error)}`;
		}
	}
	select.addEventListener("change", () => {
		select.disabled = true;
		return send({ event: "language-set", value: select.value });
	});
	function label(pack) {
		return pack.status === "verified" ? pack.name : `${pack.name} (unverified)`;
	}
	client.sendToPropertyInspector.subscribe(({ payload }) => {
		if (payload?.event !== "language-status") return;
		const packs = Array.isArray(payload.packs) ? payload.packs : [];
		const current = packs.find((p) => p.tag === payload.effective);
		// Built with textContent, never innerHTML: pack names come from files.
		select.replaceChildren();
		const auto = document.createElement("option");
		auto.value = "auto";
		auto.textContent = current ? `Automatic (${label(current)})` : "Automatic";
		select.append(auto);
		for (const pack of packs) {
			const option = document.createElement("option");
			option.value = pack.tag;
			option.textContent = label(pack);
			select.append(option);
		}
		select.value = payload.setting;
		select.disabled = !payload.loaded;
		const notes = [];
		if (payload.error) notes.push(payload.error);
		if (payload.unrecognised)
			notes.push("Teams' button labels are not in this language, so mute and camera keys cannot show state. "
				+ "If Teams is in a language not listed, see 'Languages' in the README.");
		else if (current?.status === "unverified")
			notes.push("This language has not been checked against a real Teams yet. If a key shows the wrong state, "
				+ "please report it - the plugin log lists the labels Teams uses.");
		status.textContent = notes.join(" ");
	});
	client.getConnectionInfo().then(() => send({ event: "language-status" })).catch((error) => {
		status.textContent = `Could not read the language setting: ${String(error)}`;
	});
})();
