import type {
  API,
  Characteristic as HAPCharacteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service as HAPService,
} from 'homebridge';
import { LocalLanTransport } from '../../src/transport/local/LocalLanTransport';
import type { Command } from '../../src/domain/commands';
import type { Device, Scenario } from '../../src/domain/models';
import { NodeWsFactory } from './ws';
import { configureDeviceAccessory, configureSceneAccessory, hkName, type AccessoryUpdater } from './accessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './index';

/**
 * Domiara Homebridge platform — logs into the TouchWand controller over the LAN (reusing
 * Domiara's field-tested transport), mirrors devices + scenes into Apple Home, streams live
 * state over the controller's WebSocket, and forwards HomeKit changes back as commands.
 */
/** Auto-generated controller names for units nobody configured — "10.11 Switch", "12.10 shutter". */
const UNCONFIGURED_NAME = /^\d{1,3}\.\d{1,3}(\s|$)/;

export class DomiaraPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof HAPService;
  public readonly Characteristic: typeof HAPCharacteristic;

  private readonly cached: PlatformAccessory[] = [];
  private readonly deviceById = new Map<string, Device>();
  private readonly updaters = new Map<string, AccessoryUpdater>();
  private transport?: LocalLanTransport;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.api.on('didFinishLaunching', () => {
      void this.start();
    });
  }

  /** Homebridge restores cached accessories from disk here (before didFinishLaunching). */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  /** Latest known state for a device (characteristic getters read through this). */
  currentDevice(id: string): Device | undefined {
    return this.deviceById.get(id);
  }

  send(command: Command): void {
    void this.transport
      ?.executeDeviceCommand(command)
      .catch((e: unknown) => this.log.warn(`command ${command.type} failed:`, (e as Error).message));
  }

  runScene(id: string): void {
    void this.transport
      ?.executeScenario(id)
      .catch((e: unknown) => this.log.warn('scene run failed:', (e as Error).message));
  }

  private async start(): Promise<void> {
    const host = String(this.config.host ?? '').trim();
    const username = String(this.config.username ?? '').trim();
    const password = String(this.config.password ?? '');
    if (!host || !username || !password) {
      this.log.error('Missing host, username, or password in the Domiara platform config — nothing to do.');
      return;
    }
    try {
      this.transport = new LocalLanTransport({
        host,
        port: this.config.port ? Number(this.config.port) : undefined,
        allowOverride: Boolean(this.config.allowNonPrivateHost),
        wsFactory: NodeWsFactory,
      });
      await this.transport.authenticate({ username, password });
      this.log.info(`Connected to TouchWand controller at ${host}.`);
    } catch (e: unknown) {
      this.log.error('Controller login failed:', (e as Error).message);
      return;
    }

    await this.sync();

    // Live updates over the controller WebSocket.
    this.transport.subscribeToEvents((ev) => {
      if (ev.type !== 'deviceUpdate') return;
      const prev = this.deviceById.get(ev.deviceId);
      if (!prev) return;
      const next: Device = { ...prev, state: { ...prev.state, ...ev.state } };
      this.deviceById.set(ev.deviceId, next);
      this.updaters.get(this.devUuid(ev.deviceId))?.(next);
    });

    // Periodic full refresh as a safety net if the socket misses a frame.
    const secs = Math.max(15, Number(this.config.refreshSeconds ?? 60));
    setInterval(() => {
      void this.sync().catch((e: unknown) => this.log.debug('refresh failed:', (e as Error).message));
    }, secs * 1000);
  }

  private devUuid(id: string): string {
    return this.api.hap.uuid.generate(`domiara:dev:${id}`);
  }
  private sceneUuid(id: string): string {
    return this.api.hap.uuid.generate(`domiara:scene:${id}`);
  }

  private ensureAccessory(uuid: string, name: string): PlatformAccessory {
    const existing = this.cached.find((a) => a.UUID === uuid);
    if (existing) return existing;
    const acc = new this.api.platformAccessory(hkName(name), uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.cached.push(acc);
    return acc;
  }

  /**
   * Matcher over config entries: a device id, an exact name (case-insensitive), or a name
   * pattern with `*` wildcards (e.g. `*חילוף*` matches every device whose name contains it).
   */
  private buildMatcher(v: unknown): (d: Device) => boolean {
    const entries = (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);
    const exact = new Set<string>();
    const patterns: RegExp[] = [];
    for (const e of entries) {
      if (e.includes('*')) {
        const rx = e
          .split('*')
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*');
        patterns.push(new RegExp(`^${rx}$`, 'i'));
      } else {
        exact.add(e.toLowerCase());
      }
    }
    return (d) => {
      const name = d.name.trim();
      if (exact.has(d.id.toLowerCase()) || exact.has(name.toLowerCase())) return true;
      return patterns.some((p) => p.test(name));
    };
  }

  private buildFilter(): (d: Device) => boolean {
    const include = this.buildMatcher(this.config.include);
    const exclude = this.buildMatcher(this.config.exclude);
    const hideUnconfigured = this.config.hideUnconfigured !== false;
    return (d) => {
      if (include(d)) return true;
      if (exclude(d)) return false;
      if (hideUnconfigured && UNCONFIGURED_NAME.test(d.name.trim())) return false;
      return true;
    };
  }

  private async sync(): Promise<void> {
    if (!this.transport) return;
    const includeScenes = this.config.includeScenes !== false;
    const [devices, scenes] = await Promise.all([
      this.transport.listDevices(),
      includeScenes ? this.transport.listScenarios() : Promise.resolve<Scenario[]>([]),
    ]);

    const included = this.buildFilter();
    const exposed = devices.filter(included);
    const hidden = devices.length - exposed.length;

    const live = new Set<string>();

    for (const d of devices) {
      // Track state for every device (harmless for hidden ones) so WS updates stay coherent.
      this.deviceById.set(d.id, d);
    }

    for (const d of exposed) {
      const uuid = this.devUuid(d.id);
      const acc = this.ensureAccessory(uuid, d.name);
      const updater = configureDeviceAccessory(this, acc, d);
      if (updater) {
        this.updaters.set(uuid, updater);
        updater(d);
        live.add(uuid);
      } else {
        // Type HomeKit can't represent — drop any stale accessory for it.
        this.removeAccessory(acc);
      }
    }

    for (const s of scenes) {
      const uuid = this.sceneUuid(s.id);
      const acc = this.ensureAccessory(uuid, s.name);
      configureSceneAccessory(this, acc, s);
      live.add(uuid);
    }

    // Prune accessories for devices/scenes that no longer exist.
    for (const acc of [...this.cached]) {
      if (!live.has(acc.UUID)) this.removeAccessory(acc);
    }

    this.log.info(
      `Synced ${exposed.length} devices${includeScenes ? ` and ${scenes.length} scenes` : ''} to Apple Home` +
        `${hidden ? ` (${hidden} unconfigured hidden — see the hideUnconfigured/include options)` : ''}.`,
    );
  }

  private removeAccessory(acc: PlatformAccessory): void {
    const i = this.cached.indexOf(acc);
    if (i < 0) return;
    this.cached.splice(i, 1);
    this.updaters.delete(acc.UUID);
    try {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    } catch {
      /* already gone */
    }
  }
}
