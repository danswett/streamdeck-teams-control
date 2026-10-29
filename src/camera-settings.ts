export type CameraPreference = "unchanged" | "on" | "off";

export type CameraSettings = {
	cameraId?: string;
	secondCameraId?: string;
	mirror?: CameraPreference;
	softFocus?: CameraPreference;
	brightness?: CameraPreference;
	secondMirror?: CameraPreference;
	secondSoftFocus?: CameraPreference;
	secondBrightness?: CameraPreference;
};

export function cameraArgument(settings: CameraSettings, swap: boolean): string | undefined {
	const cameras = [{
		id: settings.cameraId ?? "",
		mirror: settings.mirror ?? "unchanged",
		softFocus: settings.softFocus ?? "unchanged",
		brightness: settings.brightness ?? "unchanged"
	}];
	if (swap) cameras.push({
		id: settings.secondCameraId ?? "",
		mirror: settings.secondMirror ?? "unchanged",
		softFocus: settings.secondSoftFocus ?? "unchanged",
		brightness: settings.secondBrightness ?? "unchanged"
	});

	// Keep the original protocol for buttons that do not manage video settings.
	if (cameras.every(({ mirror, softFocus, brightness }) =>
		mirror === "unchanged" && softFocus === "unchanged" && brightness === "unchanged")) {
		return swap ? JSON.stringify(cameras.map(({ id }) => id)) : settings.cameraId;
	}
	return JSON.stringify({ cameras });
}
