import type { CharacteristicValue, PlatformAccessory } from 'homebridge';
import type { DomiaraPlatform } from './platform';
import type { Device, Scenario } from '../../src/domain/models';

/** Push-updater: called with the latest Device to refresh HomeKit characteristics. */
export type AccessoryUpdater = (device: Device) => void;

/**
 * Make a name HomeKit accepts: HAP requires it to start and end with a letter or number,
 * and rejects most symbols. We keep letters (incl. Hebrew), numbers, spaces, apostrophes,
 * dots, and dashes; everything else (%, +, geresh, trailing spaces…) becomes a space and is
 * trimmed. Falls back to "Device" if nothing valid remains.
 */
export function hkName(raw: string): string {
  let s = (raw ?? '').normalize('NFC').replace(/[^\p{L}\p{N} '.\-]+/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').trim();
  return s.length > 0 ? s : 'Device';
}

/** SerialNumber must be >1 char or HomeKit rejects the accessory; prefix the raw id. */
function serial(id: string): string {
  return `tw-${id}`;
}

function accessoryInfo(p: DomiaraPlatform, acc: PlatformAccessory, device: Device): void {
  const { Service, Characteristic } = p;
  const info = acc.getService(Service.AccessoryInformation) ?? acc.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Manufacturer, 'Domiara (TouchWand)')
    .setCharacteristic(Characteristic.Model, device.type || 'device')
    .setCharacteristic(Characteristic.Name, hkName(device.name))
    .setCharacteristic(Characteristic.SerialNumber, serial(device.id));
}

function batteryService(p: DomiaraPlatform, acc: PlatformAccessory, device: Device): AccessoryUpdater | null {
  if (device.state.batteryLevel == null) return null;
  const { Service, Characteristic } = p;
  const svc = acc.getService(Service.Battery) ?? acc.addService(Service.Battery);
  const low = (lvl: number) =>
    lvl <= 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  svc.getCharacteristic(Characteristic.BatteryLevel).onGet(() => p.currentDevice(device.id)?.state.batteryLevel ?? 100);
  svc.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => low(p.currentDevice(device.id)?.state.batteryLevel ?? 100));
  return (d) => {
    const lvl = d.state.batteryLevel ?? 100;
    svc.updateCharacteristic(Characteristic.BatteryLevel, lvl);
    svc.updateCharacteristic(Characteristic.StatusLowBattery, low(lvl));
  };
}

// ── thermostat mode mapping (HomeKit ⇆ TouchWand) ────────────────────────────────
function targetHkMode(p: DomiaraPlatform, d: Device): number {
  const C = p.Characteristic;
  if (!d.state.on) return C.TargetHeatingCoolingState.OFF;
  switch (d.state.thermostatMode) {
    case 'heat':
      return C.TargetHeatingCoolingState.HEAT;
    case 'cool':
      return C.TargetHeatingCoolingState.COOL;
    default:
      return C.TargetHeatingCoolingState.AUTO; // auto/fan/dry → AUTO (HomeKit has no fan/dry)
  }
}
function currentHkMode(p: DomiaraPlatform, d: Device): number {
  const C = p.Characteristic;
  if (!d.state.on) return C.CurrentHeatingCoolingState.OFF;
  if (d.state.thermostatMode === 'heat') return C.CurrentHeatingCoolingState.HEAT;
  return C.CurrentHeatingCoolingState.COOL;
}

/**
 * Configure a HomeKit accessory for a Domiara device and return an updater that pushes new
 * state into the characteristics. Returns null for device types HomeKit can't represent.
 */
export function configureDeviceAccessory(
  p: DomiaraPlatform,
  acc: PlatformAccessory,
  device: Device,
): AccessoryUpdater | null {
  const { Service, Characteristic } = p;
  accessoryInfo(p, acc, device);
  const battery = batteryService(p, acc, device);
  const cur = () => p.currentDevice(device.id);
  const name = hkName(device.name);

  const withBattery = (u: AccessoryUpdater): AccessoryUpdater =>
    battery ? (d) => { u(d); battery(d); } : u;

  switch (device.type) {
    case 'switch':
    case 'dimmer': {
      const svc = acc.getService(Service.Lightbulb) ?? acc.addService(Service.Lightbulb, name);
      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => !!cur()?.state.on)
        .onSet((v: CharacteristicValue) => p.send({ type: 'setOn', deviceId: device.id, on: !!v }));
      if (device.type === 'dimmer') {
        svc
          .getCharacteristic(Characteristic.Brightness)
          .onGet(() => cur()?.state.brightness ?? 0)
          .onSet((v: CharacteristicValue) =>
            p.send({ type: 'setBrightness', deviceId: device.id, brightness: Number(v) }),
          );
      }
      return withBattery((d) => {
        svc.updateCharacteristic(Characteristic.On, !!d.state.on);
        if (device.type === 'dimmer') svc.updateCharacteristic(Characteristic.Brightness, d.state.brightness ?? 0);
      });
    }

    case 'shutter': {
      const svc = acc.getService(Service.WindowCovering) ?? acc.addService(Service.WindowCovering, name);
      // HomeKit WindowCovering position: 0 = closed, 100 = open — matches our domain.
      svc.getCharacteristic(Characteristic.CurrentPosition).onGet(() => cur()?.state.shutterPosition ?? 0);
      svc
        .getCharacteristic(Characteristic.TargetPosition)
        .onGet(() => cur()?.state.shutterPosition ?? 0)
        .onSet((v: CharacteristicValue) =>
          p.send({ type: 'setShutterPosition', deviceId: device.id, position: Number(v) }),
        );
      svc.getCharacteristic(Characteristic.PositionState).onGet(() => {
        const m = cur()?.state.shutterMotion;
        return m === 'opening'
          ? Characteristic.PositionState.INCREASING
          : m === 'closing'
            ? Characteristic.PositionState.DECREASING
            : Characteristic.PositionState.STOPPED;
      });
      return withBattery((d) => {
        const pos = d.state.shutterPosition ?? 0;
        svc.updateCharacteristic(Characteristic.CurrentPosition, pos);
        svc.updateCharacteristic(Characteristic.TargetPosition, pos);
        svc.updateCharacteristic(
          Characteristic.PositionState,
          d.state.shutterMotion === 'opening'
            ? Characteristic.PositionState.INCREASING
            : d.state.shutterMotion === 'closing'
              ? Characteristic.PositionState.DECREASING
              : Characteristic.PositionState.STOPPED,
        );
      });
    }

    case 'thermostat': {
      const svc = acc.getService(Service.Thermostat) ?? acc.addService(Service.Thermostat, name);
      svc.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => cur()?.state.currentTemperature ?? 20);
      svc
        .getCharacteristic(Characteristic.TargetTemperature)
        .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
        .onGet(() => cur()?.state.targetTemperature ?? 22)
        .onSet((v: CharacteristicValue) =>
          p.send({ type: 'thermostatTarget', deviceId: device.id, celsius: Number(v) }),
        );
      svc
        .getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .onGet(() => targetHkMode(p, cur() ?? device))
        .onSet((v: CharacteristicValue) => {
          const C = Characteristic;
          const n = Number(v);
          if (n === C.TargetHeatingCoolingState.OFF) {
            p.send({ type: 'thermostatPower', deviceId: device.id, on: false });
          } else {
            p.send({ type: 'thermostatPower', deviceId: device.id, on: true });
            const mode = n === C.TargetHeatingCoolingState.HEAT ? 'heat' : n === C.TargetHeatingCoolingState.COOL ? 'cool' : 'auto';
            p.send({ type: 'thermostatMode', deviceId: device.id, mode });
          }
        });
      svc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).onGet(() => currentHkMode(p, cur() ?? device));
      return withBattery((d) => {
        svc.updateCharacteristic(Characteristic.CurrentTemperature, d.state.currentTemperature ?? 20);
        svc.updateCharacteristic(Characteristic.TargetTemperature, d.state.targetTemperature ?? 22);
        svc.updateCharacteristic(Characteristic.TargetHeatingCoolingState, targetHkMode(p, d));
        svc.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentHkMode(p, d));
      });
    }

    case 'alarmsensor':
    case 'bsensor': {
      // Contact sensors carry contactOpen; everything else we treat as motion.
      if (device.state.contactOpen != null) {
        const svc = acc.getService(Service.ContactSensor) ?? acc.addService(Service.ContactSensor, name);
        svc.getCharacteristic(Characteristic.ContactSensorState).onGet(() => (cur()?.state.contactOpen ? 1 : 0));
        return withBattery((d) => svc.updateCharacteristic(Characteristic.ContactSensorState, d.state.contactOpen ? 1 : 0));
      }
      const svc = acc.getService(Service.MotionSensor) ?? acc.addService(Service.MotionSensor, name);
      svc.getCharacteristic(Characteristic.MotionDetected).onGet(() => !!cur()?.state.motion);
      return withBattery((d) => svc.updateCharacteristic(Characteristic.MotionDetected, !!d.state.motion));
    }

    default:
      // wallcontroller / unknown → not exposed to HomeKit.
      return null;
  }
}

/** A scene → a stateless HomeKit switch that runs the scenario and springs back off. */
export function configureSceneAccessory(p: DomiaraPlatform, acc: PlatformAccessory, scene: Scenario): void {
  const { Service, Characteristic } = p;
  accessoryInfo(p, acc, { id: scene.id, type: 'switch', name: scene.name, state: {} } as unknown as Device);
  const svc = acc.getService(Service.Switch) ?? acc.addService(Service.Switch, hkName(scene.name));
  svc
    .getCharacteristic(Characteristic.On)
    .onGet(() => false)
    .onSet((v: CharacteristicValue) => {
      if (v) {
        p.runScene(scene.id);
        setTimeout(() => svc.updateCharacteristic(Characteristic.On, false), 800);
      }
    });
}
