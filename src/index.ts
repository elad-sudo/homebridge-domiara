import type { API } from 'homebridge';
import { DomiaraPlatform } from './platform';

export const PLATFORM_NAME = 'Domiara';
export const PLUGIN_NAME = 'homebridge-domiara';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, DomiaraPlatform);
};
