(() => {
	// Teams control on macOS. The section stays hidden unless the plugin says
	// this is a Mac, so Windows never shows a setting it has no use for.
	const client = SDPIComponents.streamDeckClient;
	const section = document.getElementById("teams-control");
	const enabled = document.getElementById("teams-control-enabled");
	const status = document.getElementById("teams-control-status");
	if (!section || !enabled || !status) return;

	function describe(payload) {
		if (payload.error) return payload.error;
		if (payload.enabled !== true) return "Off. Teams keys do nothing until this is on.";
		if (payload.accessibility === false)
			return "Waiting for macOS: turn on Stream Deck under System Settings > Privacy & Security > Accessibility.";
		if (payload.accessibility === true) return "On. Stream Deck has Accessibility permission.";
		return "";
	}

	async function send(payload) {
		try {
			await client.send("sendToPlugin", payload);
		} catch (error) {
			enabled.disabled = false;
			status.textContent = `Could not contact the plugin: ${String(error)}`;
		}
	}

	enabled.addEventListener("change", () => {
		enabled.disabled = true;
		return send({ event: "teams-control-set", enabled: enabled.checked });
	});

	client.sendToPropertyInspector.subscribe(({ payload }) => {
		if (payload?.event !== "teams-control-status") return;
		if (!payload.supported) {
			section.hidden = true;
			return;
		}
		section.hidden = false;
		enabled.checked = payload.enabled === true;
		enabled.disabled = !payload.loaded || payload.busy === true;
		status.textContent = describe(payload);
	});

	client.getConnectionInfo().then(() => send({ event: "teams-control-status" })).catch((error) => {
		status.textContent = `Could not read Teams control status: ${String(error)}`;
	});
})();
