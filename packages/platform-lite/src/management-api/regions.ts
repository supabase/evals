import type { components } from './types.js';

export type RegionsInfo = components['schemas']['RegionsInfo'];
type SmartGroup = RegionsInfo['all']['smartGroup'][number];
type SpecificRegion = RegionsInfo['all']['specific'][number];

const SMART_GROUPS: SmartGroup[] = [
  { name: 'Americas', code: 'americas', type: 'smartGroup' },
  { name: 'Europe, Middle East and Africa', code: 'emea', type: 'smartGroup' },
  { name: 'Asia Pacific', code: 'apac', type: 'smartGroup' },
];

const REGIONS: Array<[SpecificRegion['code'], string]> = [
  ['us-east-1', 'East US (North Virginia)'],
  ['us-east-2', 'East US (Ohio)'],
  ['us-west-1', 'West US (North California)'],
  ['us-west-2', 'West US (Oregon)'],
  ['ca-central-1', 'Canada (Central)'],
  ['sa-east-1', 'South America (Sao Paulo)'],
  ['eu-west-1', 'West EU (Ireland)'],
  ['eu-west-2', 'West EU (London)'],
  ['eu-west-3', 'West EU (Paris)'],
  ['eu-north-1', 'North EU (Stockholm)'],
  ['eu-central-1', 'Central EU (Frankfurt)'],
  ['eu-central-2', 'Central Europe (Zurich)'],
  ['ap-southeast-1', 'Southeast Asia (Singapore)'],
  ['ap-northeast-1', 'Northeast Asia (Tokyo)'],
  ['ap-northeast-2', 'Northeast Asia (Seoul)'],
  ['ap-east-1', 'East Asia (Hong Kong)'],
  ['ap-southeast-2', 'Oceania (Sydney)'],
  ['ap-south-1', 'South Asia (Mumbai)'],
];

export function regionsInfo(unavailableRegions: string[] = []): RegionsInfo {
  const specific = REGIONS.map(
    ([code, name]): SpecificRegion => ({
      name,
      code,
      type: 'specific',
      provider: 'AWS',
      ...(unavailableRegions.includes(code) ? { status: 'capacity' } : {}),
    })
  );
  return {
    recommendations: { smartGroup: SMART_GROUPS[0]!, specific },
    all: { smartGroup: SMART_GROUPS, specific },
  };
}
