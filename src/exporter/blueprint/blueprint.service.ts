import { Injectable } from '@angular/core';

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { QUALITY_REGEX } from '~/data/schema/quality';
import { rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { Dataset } from '~/state/settings/dataset';

import {
  BlueprintInsertPlan,
  getQualityString,
  IBlueprintData,
  IEntity,
  IIcon,
} from './blueprint-types';

export interface CompactBlock {
    step: Step;
    numMachines: number;
    w: number;
    h: number;
    cols: number;
    rows: number;
    mBlockW: number;
    mBlockH: number;
    blockW: number;
    blockH: number;
    stepNumBeacons: number;
    bWidth: number;
    bHeight: number;
    beaconId?: string;
    beaconModules?: { id?: string, count?: { isZero: () => boolean, toNumber: () => number } }[];
    beaconsLeft: number;
    beaconsRight: number;
    beaconColW: number;
    machineIdStr: string;
    recipeId: string;
}

export const FACTORIO_2_1_VERSION = 562954248847360; // Factorio 2.1.7.0

@Injectable({
  providedIn: 'root',
})
export class BlueprintService {
  private sortStepsByInputs<T extends { step: Step }>(items: T[], data: Dataset, depths?: Map<string, number>): T[] {
      const getIoCount = (step: Step): number => {
          if (!step.recipeId) return 0;
          const recipe = data.recipeRecord?.[step.recipeId];
          let count = 0;
          let hasPetro = false;

          const checkPetro = (k: string): void => {
              if (k.includes('oil') || k.includes('petroleum') || k.includes('lubricant') || k.includes('acid') || k.includes('sulfur') || k.includes('plastic') || k.includes('explosive')) {
                  hasPetro = true;
              }
          };

          if (recipe?.in) {
              const keys = Object.keys(recipe.in);
              count += keys.length;
              keys.forEach(checkPetro);
          }
          if (recipe?.out) {
              const keys = Object.keys(recipe.out);
              count += keys.length;
              keys.forEach(checkPetro);
          }

          if (hasPetro) {
              // Weight petro machines heavily so they group together at the bottom.
              // Giving them all the same count forces them to be sorted perfectly by depth!
              return 100;
          }

          return count;
      };

      const getDepth = (step: Step): number => {
          if (!step.id || !depths) return 0;
          return depths.get(step.id) ?? 0;
      };
      
      const getInputsString = (step: Step): string => {
          if (!step.recipeId) return '';
          const recipe = data.recipeRecord?.[step.recipeId];
          let str = '';
          if (recipe?.in) str += Object.keys(recipe.in).sort().join(',');
          str += '|';
          if (recipe?.out) str += Object.keys(recipe.out).sort().join(',');
          return str;
      };

      return [...items].sort((a, b) => {
          // 1. Fewest raw ingredients + outputs at the top
          const countA = getIoCount(a.step);
          const countB = getIoCount(b.step);
          if (countA !== countB) return countA - countB;

          // 2. Objectives (highest depth) to the right (placed later in the row)
          const depthA = getDepth(a.step);
          const depthB = getDepth(b.step);
          if (depthA !== depthB) return depthA - depthB;
          
          // 3. Tie-breaker: group similar inputs/outputs together
          const inputsA = getInputsString(a.step);
          const inputsB = getInputsString(b.step);
          return inputsA.localeCompare(inputsB);
      });
  }

  async encodeBlueprintString(blueprintData: IBlueprintData): Promise<string> {
    const jsonString = JSON.stringify(blueprintData);
    const utf8Bytes = new TextEncoder().encode(jsonString);
    
    // Factorio expects zlib (RFC 1950) compression. 
    // CompressionStream('deflate') produces exactly this format in browsers.
    const stream = new Blob([utf8Bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    const compressedBuffer = await new Response(stream).arrayBuffer();
    const compressedBytes = new Uint8Array(compressedBuffer);
    
    // Base64 encode the compressed binary data
    let binaryString = '';
    for (const byte of compressedBytes) {
      binaryString += String.fromCharCode(byte);
    }
    return '0' + btoa(binaryString);
  }

  async generateBlueprintFromSteps(steps: Step[], data: Dataset, inputBelts: { beltId: string, itemId: string, count: number }[] = [], combinatorSteps: Step[] = []): Promise<string> {
      const entities: IEntity[] = [];
      let entity_number = 1;
    const incomingEdges = new Map<string, string[]>();
    for (const step of steps) {
      if (!step.id) continue;
      if (!incomingEdges.has(step.id)) incomingEdges.set(step.id, []);
    }

    for (const step of steps) {
      if (!step.id || !step.parents) continue;
      for (const parentId of Object.keys(step.parents)) {
         if (parentId === '') continue; // '' is output
         if (!incomingEdges.has(parentId)) incomingEdges.set(parentId, []);
         incomingEdges.get(parentId)?.push(step.id);
      }
    }

    const depths = new Map<string, number>();
    const calcDepth = (id: string, visited: Set<string>): number => {
      if (depths.has(id)) return depths.get(id) ?? 0;
      if (visited.has(id)) return 0; // Cycle detected
      visited.add(id);

      const incoming = incomingEdges.get(id) ?? [];
      let maxDepth = 0;
      for (const inc of incoming) {
        maxDepth = Math.max(maxDepth, calcDepth(inc, visited) + 1);
      }
      
      visited.delete(id);
      depths.set(id, maxDepth);
      return maxDepth;
    };

    for (const step of steps) {
       if (step.id && !depths.has(step.id)) {
           calcDepth(step.id, new Set());
       }
    }

      
      let blocks: CompactBlock[] = [];
      let totalArea = 0;
      
      for (const step of steps) {
          const numMachines = Math.ceil(step.machines?.toNumber() ?? 0);
          if (numMachines <= 0) continue;
          
          const recipeId = step.recipeId;
          const recipeSettings = step.recipeSettings;
          if (!recipeId || !recipeSettings?.machineId) continue;
          
          const machineIdStr = recipeSettings.machineId;
          const [w, h] = this.getMachineSize(machineIdStr, data);
          
          let stepNumBeacons = 0;
          let bWidth = 3;
          let bHeight = 3;
          const beacons = recipeSettings.beacons ?? [];
          const foundBeacon = beacons.find(b => b.id && b.count && !b.count.isZero());
          if (foundBeacon?.id) {
              stepNumBeacons = Math.ceil((foundBeacon.total ?? foundBeacon.count ?? rational.zero).toNumber());
              const beaconRecord = data.beaconRecord[foundBeacon.id];
              bWidth = beaconRecord?.size?.[0] ?? 3;
              bHeight = beaconRecord?.size?.[1] ?? 3;
          }
          
          // Format machines into a square-ish grid
          const cols = Math.ceil(Math.sqrt(numMachines * (h / w)));
          const rows = Math.ceil(numMachines / cols);
          
          const mBlockW = cols * w;
          const mBlockH = rows * h;
          
          // If we have beacons, we'll just put them in a column on the left and right of the machine block
          const beaconsLeft = Math.ceil(stepNumBeacons / 2);
          const beaconsRight = Math.floor(stepNumBeacons / 2);
          const beaconColW = stepNumBeacons > 0 ? bWidth : 0;
          
          const blockW = mBlockW + (beaconsLeft > 0 ? beaconColW : 0) + (beaconsRight > 0 ? beaconColW : 0);
          const blockH = Math.max(mBlockH, Math.ceil(beaconsLeft) * bHeight, Math.ceil(beaconsRight) * bHeight);
          
          totalArea += blockW * blockH;
          
          blocks.push({
              step, numMachines, w, h, cols, rows, mBlockW, mBlockH,
              blockW, blockH, stepNumBeacons, bWidth, bHeight,
              beaconId: foundBeacon?.id, beaconModules: foundBeacon?.modules,
              beaconsLeft, beaconsRight, beaconColW, machineIdStr, recipeId
          });
      }
      
      // Shelf packing using input vector sorting to keep related machines adjacent
      blocks = this.sortStepsByInputs(blocks, data, depths);
      const targetWidth = Math.max(...blocks.map(b => b.blockW), Math.ceil(Math.sqrt(totalArea)));
      
      let currentX = 0;
      let currentY = 0;
      let rowHeight = 0;
      
      for (const block of blocks) {
          if (currentX + block.blockW > targetWidth && currentX > 0) {
              currentX = 0;
              currentY += rowHeight;
              rowHeight = 0;
          }
          
          let bX = currentX;
          const bY = currentY;
          
          // Place Left Beacons
          if (block.beaconsLeft > 0) {
              let beaconY = bY;
              for (let j = 0; j < block.beaconsLeft; j++) {
                  this.placeBeaconCompact(entities, entity_number++, block, bX, beaconY);
                  beaconY += block.bHeight;
              }
              bX += block.beaconColW;
          }
          
          // Place Machines
          let mX = bX;
          let mY = bY;
          let placed = 0;
          for (let r = 0; r < block.rows; r++) {
              for (let c = 0; c < block.cols; c++) {
                  if (placed >= block.numMachines) break;
                  
                  const { baseId: machineBaseId, level: machineQualityLevel } = this.parseQualityId(block.machineIdStr);
                  const { baseId: recipeBaseId, level: recipeQualityLevel } = this.parseQualityId(block.recipeId);
                  const machineModulesPlan = this.generateInsertPlan(block.step.recipeSettings!.modules, block.machineIdStr) ?? [];
                  
                  const entity: IEntity = {
                      entity_number: entity_number++,
                      name: machineBaseId,
                      position: { x: mX + block.w / 2, y: mY + block.h / 2 },
                      recipe: recipeBaseId,
                      recipe_quality: getQualityString(recipeQualityLevel),
                      quality: getQualityString(machineQualityLevel),
                      items: machineModulesPlan,
                  };
                  if (block.machineIdStr.toLowerCase().includes('crusher')) {
                      entity.direction = 4;
                  }
                  entities.push(entity);
                  
                  mX += block.w;
                  placed++;
              }
              mX = bX;
              mY += block.h;
          }
          bX += block.mBlockW;
          
          // Place Right Beacons
          if (block.beaconsRight > 0) {
              let beaconY = bY;
              for (let j = 0; j < block.beaconsRight; j++) {
                  this.placeBeaconCompact(entities, entity_number++, block, bX, beaconY);
                  beaconY += block.bHeight;
              }
          }
          
          currentX += block.blockW;
          rowHeight = Math.max(rowHeight, block.blockH);
      }
      
      const icons: IIcon[] = [];
      const mainIconItem = steps.find(s => s.output?.gt(rational.zero))?.itemId ?? steps[0]?.itemId;
      if (mainIconItem) {
          const { baseId: iconBaseId } = this.parseQualityId(mainIconItem);
          icons.push({
              index: 1,
              signal: { type: data.itemRecord[iconBaseId]?.stack ? 'item' : 'fluid', name: iconBaseId },
          });
      }
      
      this.addExcludedStepsCombinator(entities, combinatorSteps, data);
      this.addInputBeltsCombinator(entities, inputBelts, data);
      
      const blueprintData: IBlueprintData = {
          blueprint: {
              version: FACTORIO_2_1_VERSION,
              item: 'blueprint',
              label: 'FactorioLab Compact Export',
              icons,
              entities,
          },
      };
      
      return this.encodeBlueprintString(blueprintData);
  }

  private placeBeaconCompact(entities: IEntity[], entity_number: number, block: CompactBlock, x: number, y: number): void {
      const parsed = this.parseQualityId(block.beaconId!);
      const beaconModulesPlan = this.generateInsertPlan(block.beaconModules, block.beaconId!) ?? [];
      entities.push({
          entity_number: entity_number,
          name: parsed.baseId,
          position: { x: x + block.bWidth / 2, y: y + block.bHeight / 2 },
          quality: getQualityString(parsed.level ?? 0),
          items: beaconModulesPlan,
      });
  }

  private addExcludedStepsCombinator(entities: IEntity[], excludedSteps: Step[], data: Dataset): void {
      if (!excludedSteps || excludedSteps.length === 0) return;
      
      const parametersByMachine = new Map<string, string[]>();
      
      for (const step of excludedSteps) {
          let machineId = step.recipeSettings?.machineId ?? '';
          let itemId = step.itemId;
          if (!itemId) itemId = step.recipeId;
          
          if (!machineId && itemId === 'crude-oil') machineId = 'pumpjack';
          if (!machineId && itemId === 'water') machineId = 'offshore-pump';
          
          let numMachines = Math.ceil(step.machines?.toNumber() ?? 0);
          if (numMachines <= 0 && (machineId === 'pumpjack' || machineId === 'offshore-pump')) {
              numMachines = 1;
          }
          if (numMachines <= 0 || !itemId) continue;
          
          const { baseId: machineBaseId } = this.parseQualityId(machineId);
          const { baseId: itemBaseId } = this.parseQualityId(itemId);
          const type = data.itemRecord[itemBaseId]?.stack ? 'item' : 'fluid';
          const itemTag = `[${type}=${itemBaseId}]`;
          const entityTag = `[entity=${machineBaseId}]`;
          
          let moduleString = '';
          if (step.recipeSettings?.modules) {
              for (const mod of step.recipeSettings.modules) {
                  if (mod.id && mod.id !== 'module') {
                      const count = Math.ceil(mod.count?.toNumber() ?? 0);
                      if (count > 0) {
                          const { baseId: modBaseId } = this.parseQualityId(mod.id);
                          moduleString += ` ${count}[item=${modBaseId}]`;
                      }
                  }
              }
          }
          
          const text = `${numMachines} ${entityTag}${moduleString} ${itemTag}`;
          if (!parametersByMachine.has(machineBaseId)) {
              parametersByMachine.set(machineBaseId, []);
          }
          parametersByMachine.get(machineBaseId)!.push(text);
      }
      
      if (parametersByMachine.size > 0) {
          let displayX = 0;
          let displayY = -2;
          if (entities.length > 0) {
              displayX = entities[0].position.x;
              displayY = entities[0].position.y - 2;
          }
          
          let i = 0;
          for (const lines of parametersByMachine.values()) {
              entities.push({
                  entity_number: entities.length + 1,
                  name: 'constant-combinator',
                  position: { x: displayX + i, y: displayY },
                  player_description: lines.join('\n'),
              });
              i++;
          }
      }
  }

  private addInputBeltsCombinator(entities: IEntity[], inputBelts: { beltId: string, itemId: string, count: number }[], data: Dataset): void {
      if (!inputBelts || inputBelts.length === 0) return;
      
      const parameters: string[] = [];
      for (const belt of inputBelts) {
          const { baseId: beltBaseId } = this.parseQualityId(belt.beltId);
          const { baseId: itemBaseId } = this.parseQualityId(belt.itemId);
          
          const type = data.itemRecord[itemBaseId]?.stack ? 'item' : 'fluid';
          const beltTag = `[entity=${beltBaseId}]`;
          const itemTag = `[${type}=${itemBaseId}]`;
          
          parameters.push(`${belt.count} ${beltTag} ${itemTag}`);
      }
      
      if (parameters.length > 0) {
          let displayX = 0;
          let displayY = -4; // Place it slightly higher up
          if (entities.length > 0) {
              displayX = entities[0].position.x;
              displayY = entities[0].position.y - 4;
          }
          
          entities.push({
              entity_number: entities.length + 1,
              name: 'constant-combinator',
              position: { x: displayX, y: displayY },
              player_description: parameters.join('\n'),
          });
      }
  }
  private parseQualityId(id: string): { baseId: string; level?: number } {
    const match = QUALITY_REGEX.exec(id);
    if (match) {
      return { baseId: match[1], level: parseInt(match[2], 10) };
    }
    return { baseId: id };
  }

  private getMachineSize(machineId: string, data: Dataset): [number, number] {
    const record = data.machineRecord[machineId];
    let w = record?.size?.[0] ?? 3;
    let h = record?.size?.[1] ?? 3;
    if (machineId.toLowerCase().includes('crusher')) {
      const temp = w; w = h; h = temp;
    }
    return [w, h];
  }

  private generateInsertPlan(modules: { id?: string, count?: { isZero: () => boolean, toNumber: () => number } }[] | undefined, entityId: string): BlueprintInsertPlan[] | undefined {
    if (!modules || modules.length === 0) return undefined;

    // Determine module inventory index based on entity name heuristic
    let inventory = 4; // Default to crafter_modules (assembling-machine, furnace, etc)
    const lowerId = entityId.toLowerCase();
    if (lowerId.includes('beacon')) {
      inventory = 1;
    } else if (lowerId.includes('lab')) {
      inventory = 3;
    }

    const plan: BlueprintInsertPlan[] = [];
    let currentStack = 0;

    for (const mod of modules) {
      if (!mod.id || !mod.count || mod.count.isZero()) continue;

      const count = Math.ceil(mod.count.toNumber());
      const { baseId: modBaseId, level: modQualityLevel } = this.parseQualityId(mod.id);

      const in_inventory: { inventory: number; stack: number }[] = [];
      for (let i = 0; i < count; i++) {
        in_inventory.push({
          inventory,
          stack: currentStack++
        });
      }

      plan.push({
        id: {
          name: modBaseId,
          quality: getQualityString(modQualityLevel),
        },
        items: {
          in_inventory
        }
      });
    }

    return plan.length > 0 ? plan : undefined;
  }
}
