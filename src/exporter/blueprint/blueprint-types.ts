export interface IPoint {
  x: number;
  y: number;
}

export type SignalType = 'item' | 'virtual' | 'fluid' | 'recipe' | 'entity' | 'space-location' | 'asteroid-chunk' | 'quality';

export interface ISignal {
  name?: string;
  type?: SignalType;
}

export interface InventoryPosition {
  inventory: number; // For definitions see factorio API, but we might just need this to exist
  stack: number;
  count?: number;
}

export interface BlueprintItemIDAndQualityIDPair {
  name: string;
  quality?: string;
}

export interface ItemInventoryPositions {
  in_inventory?: InventoryPosition[];
  grid_count?: number;
}

export interface BlueprintInsertPlan {
  id: BlueprintItemIDAndQualityIDPair;
  items: ItemInventoryPositions;
}

export interface IEntity {
  entity_number: number;
  name: string;
  position: IPoint;
  direction?: number;
  recipe?: string;
  recipe_quality?: string;
  items?: Record<string, number> | BlueprintInsertPlan[]; // Pre-2.0 or Post-2.0 modules
  quality?: string; // Entity quality
  
  // Display Panel fields
  text?: string;
  icon?: ISignal;
  always_show?: boolean;
  show_in_chart?: boolean;
}

export interface IIcon {
  index: 1 | 2 | 3 | 4;
  signal: ISignal;
}

export interface IBlueprint {
  version: number;
  item: 'blueprint';
  icons: IIcon[];
  label?: string;
  description?: string;
  entities?: IEntity[];
}

export interface IBlueprintData {
  blueprint: IBlueprint;
}

export const QUALITY_LEVEL_MAP: Record<number, string> = {
  1: 'uncommon',
  2: 'rare',
  3: 'epic',
  4: 'legendary',
  5: 'legendary', // fallback just in case
};

export function getQualityString(level?: number): string | undefined {
  if (level == null || level === 0) return undefined;
  return QUALITY_LEVEL_MAP[level];
}
