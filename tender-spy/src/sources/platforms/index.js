import avtodor from './avtodor.js';
import b2bcenter from './b2bcenter.js';
import etpets from './etpets.js';
import etprf from './etprf.js';
import fabrikant from './fabrikant.js';
import rad from './rad.js';
import roseltorg from './roseltorg.js';
import tektorg from './tektorg.js';
import torgi from './torgi.js';
import zakazrf from './zakazrf.js';

export const PLATFORMS = [roseltorg, etpets, fabrikant, tektorg, b2bcenter, zakazrf, etprf, avtodor, torgi, rad];

export const PLATFORM_IDS = PLATFORMS.map((p) => p.id);

export function platformInfo() {
  return PLATFORMS.map(({ id, name, site, category }) => ({ id, name, site, category }));
}
