export async function connectBluetooth(log) {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is not available in this browser.");
  }

  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: ["battery_service"],
  });

  const server = await device.gatt.connect();
  log?.(`Bluetooth connected: ${device.name || device.id}`);
  return { device, server };
}
