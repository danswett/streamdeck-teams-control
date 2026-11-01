(() => {
	const client = SDPIComponents.streamDeckClient;
	const status = document.getElementById("profile-status");
	const following = document.getElementById("profile-following");
	async function send(payload) {
		try {
			await client.send("sendToPlugin", payload);
		} catch (error) {
			following.disabled = false;
			status.textContent = `Could not contact the plugin: ${String(error)}`;
		}
	}
	following.addEventListener("change", () => {
		following.disabled = true;
		return send({ event: "profile-following-set", enabled: following.checked });
	});
	client.sendToPropertyInspector.subscribe(({ payload }) => {
		if (payload?.event !== "profile-following-status") return;
		following.checked = payload.enabled;
		following.disabled = !payload.loaded;
		const hint = payload.enabled && payload.paused
			? "Automatic following is paused while a profile change is pending or unconfirmed. "
				+ "Close any install prompt, then turn following off and on to retry."
			: "";
		status.textContent = [payload.error, hint].filter(Boolean).join(" ");
	});
	client.getConnectionInfo().then(() => send({ event: "profile-following-status" })).catch((error) => {
		status.textContent = `Could not read profile status: ${String(error)}`;
	});
})();
