import { Injectable } from '@angular/core';

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

export const FACTORIO_2_1_VERSION = 562954248847360; // Factorio 2.1.7.0

@Injectable({
  providedIn: 'root',
})
export class BlueprintService {
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

  async generateBlueprintFromSteps(steps: Step[], data: Dataset, isSpacePlatformLayout = false): Promise<string> {
    const entities: IEntity[] = [];
    let entity_number = 1;

    // 1. Build Adjacency List for DAG depth calculation
    const incomingEdges = new Map<string, string[]>();
    const stepMap = new Map<string, Step>();
    for (const step of steps) {
      if (!step.id) continue;
      stepMap.set(step.id, step);
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

    // 2. Calculate Topological Depth
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

    const isGatherer = (step: Step): boolean => {
       const machineId = step.recipeSettings?.machineId?.toLowerCase() || '';
       return machineId.includes('mining-drill') || machineId.includes('pumpjack') || machineId.includes('offshore-pump');
    };

    // --- HORIZONTAL COMPRESSION PASS ---
    const consumersOf = new Map<string, string[]>();
    for (const step of steps) {
      if (step.id) consumersOf.set(step.id, []);
    }
    for (const [consumer, producers] of incomingEdges.entries()) {
        for (const producer of producers) {
            let arr = consumersOf.get(producer);
            if (!arr) {
                arr = [];
                consumersOf.set(producer, arr);
            }
            arr.push(consumer);
        }
    }

    let globalMaxDepth = 0;
    for (const d of depths.values()) {
        globalMaxDepth = Math.max(globalMaxDepth, d);
    }

    const getMachineWidth = (id: string): number => {
        const step = stepMap.get(id);
        if (!step?.recipeSettings?.machineId) return 3;
        return data.machineRecord[step.recipeSettings.machineId]?.size?.[0] ?? 3;
    };

    const countMap = new Map<string, number>();
    for (const [id, depth] of depths.entries()) {
        const step = stepMap.get(id);
        if (!step?.machines || step.machines.isZero() || isGatherer(step)) continue;
        const width = getMachineWidth(id);
        const key = `${depth}_${width}`;
        countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 100) {
        changed = false;
        iterations++;
        
        for (const step of steps) {
            if (!step.id || !step.machines || step.machines.isZero() || isGatherer(step)) continue;
            
            const u = step.id;
            const width = getMachineWidth(u);
            const currentDepth = depths.get(u) ?? 0;
            
            let min_d = 0;
            const producers = incomingEdges.get(u) ?? [];
            for (const p of producers) {
                min_d = Math.max(min_d, (depths.get(p) ?? 0) + 1);
            }
            
            let max_d = globalMaxDepth;
            const consumers = consumersOf.get(u) ?? [];
            for (const v of consumers) {
                max_d = Math.min(max_d, (depths.get(v) ?? globalMaxDepth) - 1);
            }
            
            if (min_d > max_d) continue;
            
            let best_d = currentDepth;
            let current_count = countMap.get(`${currentDepth}_${width}`) ?? 0;
            
            if (consumers.length === 0) {
                if (currentDepth !== max_d) {
                    best_d = max_d;
                }
            } else {
                for (let test_d = min_d; test_d <= max_d; test_d++) {
                    if (test_d === currentDepth) continue;
                    const test_count = countMap.get(`${test_d}_${width}`) ?? 0;
                    
                    let shouldMove = false;
                    if (current_count <= 2 && test_count > 0) {
                        shouldMove = true;
                    } else if (test_count > current_count) {
                        shouldMove = true;
                    }
                    
                    if (shouldMove) {
                        best_d = test_d;
                        current_count = test_count + 1;
                    }
                }
            }
            
            if (best_d !== currentDepth) {
                const oldKey = `${currentDepth}_${width}`;
                const newKey = `${best_d}_${width}`;
                countMap.set(oldKey, (countMap.get(oldKey) ?? 1) - 1);
                countMap.set(newKey, (countMap.get(newKey) ?? 0) + 1);
                depths.set(u, best_d);
                changed = true;
            }
        }
    }

    // 3. Grid Layout Setup

    const targetSteps: Step[] = [];
    for (const step of steps) {
       if (!step.id || step.machines == null || step.machines.isZero() || isGatherer(step)) continue;
       targetSteps.push({
          ...step,
          machines: rational(Math.ceil(step.machines.toNumber()))
       });
    }

    if (targetSteps.length === 0) {
      return this.encodeBlueprintString({
        blueprint: {
          version: FACTORIO_2_1_VERSION,
          item: 'blueprint',
          label: 'FactorioLab Export',
          icons: [],
          entities: [],
        },
      });
    }

    // Group steps by depth and machine width
    const colKeysArr: { depth: number; width: number; key: string }[] = [];
    const stepsByCol: Record<string, Step[]> = {};
    const stepColKey = new Map<string, string>();

    for (const step of targetSteps) {
      const depth = depths.get(step.id) ?? 0;
      const recipeSettings = step.recipeSettings;
      const width = recipeSettings?.machineId
          ? (data.machineRecord[recipeSettings.machineId]?.size?.[0] ?? 3)
          : 3;
      
      const key = `${depth}-${width}`;
      if (!stepsByCol[key]) {
          stepsByCol[key] = [];
          colKeysArr.push({ depth, width, key });
      }
      stepsByCol[key].push(step);
      stepColKey.set(step.id, key);
    }

    // Sort colKeys ascending by depth, then descending by width
    colKeysArr.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        return b.width - a.width;
    });
    const colKeys = colKeysArr.map(c => c.key);
    const maxDepth = Math.max(0, ...colKeysArr.map(c => c.depth));

    // Check which depths need beacons
    const hasBeaconLeft = new Map<number, boolean>();
    const hasBeaconRight = new Map<number, boolean>();
    
    for (let i = 0; i < colKeys.length; i++) {
      const colKey = colKeys[i];
      let needsBeacon = false;
      for (const step of stepsByCol[colKey]) {
         const foundBeacon = (step.recipeSettings?.beacons ?? []).find(b => b.id && b.count && !b.count.isZero());
         if (foundBeacon) needsBeacon = true;
      }
      if (needsBeacon) {
         hasBeaconLeft.set(i, true);
         hasBeaconRight.set(i, true);
      }
    }

    // Determine widths for X calculation
    const beaconColX = new Map<number, number>(); // beacon left of depth
    const machineColX = new Map<number, number>(); // machine at depth
    let farRightBeaconX = 0;
    /* eslint-disable @typescript-eslint/no-non-null-assertion */


    let runningX = 0;
    const maxMachineWidthAtDepth = new Map<number, number>();
    const maxBeaconWidthAtDepth = new Map<number, number>();

    for (let i = 0; i < colKeys.length; i++) {
        const colKey = colKeys[i];
        let maxW = 0;
        let maxBW = 0;
        for (const step of stepsByCol[colKey]) {
            const recipeSettings = step.recipeSettings;
            if (!recipeSettings?.machineId) continue;
            const width = data.machineRecord[recipeSettings.machineId]?.size?.[0] ?? 3;
            maxW = Math.max(maxW, width);
            const foundBeacon = (recipeSettings.beacons ?? []).find(b => b.id && b.count && !b.count.isZero());
            if (foundBeacon?.id) {
               const bW = data.beaconRecord[foundBeacon.id]?.size?.[0] ?? 3;
               maxBW = Math.max(maxBW, bW);
            }
        }
        maxMachineWidthAtDepth.set(i, maxW);
        maxBeaconWidthAtDepth.set(i, maxBW);

        const needsBeacon = hasBeaconRight.get(i + 1) || hasBeaconLeft.get(i);
        if (needsBeacon) {
            beaconColX.set(i, runningX);
            const bW = Math.max(maxBeaconWidthAtDepth.get(i + 1) ?? 3, maxBW || 3);
            const gap = isSpacePlatformLayout ? 0 : 1;
            runningX += bW + gap;
        }

        machineColX.set(i, runningX);
        const gap = isSpacePlatformLayout ? 0 : 1;
        runningX += maxW + gap;
    }

    if (hasBeaconRight.get(colKeys.length - 1)) {
        farRightBeaconX = runningX;
    }

    // Determine Y coordinates based on outputs
    const stepCenterY = new Map<string, number>();
    let currentOutputY = 0;

    // We process columns from N-1 down to 0
    const reverseColIndexes = colKeys.map((_, i) => i).sort((a, b) => b - a);
    
    // Sort outputs by their order in targets array
    const targets: string[] = [];
    for (const step of steps) {
      if (step.id && step.parents?.[''] && !step.parents[''].isZero()) {
         targets.push(step.id);
      }
    }
    const targetOrder = new Map<string, number>();
    targets.forEach((t, i) => targetOrder.set(t, i));

    for (const i of reverseColIndexes) {
       const colKey = colKeys[i];
       const stepsAtCol = stepsByCol[colKey];
       const isTargetCol = colKeysArr[i].depth === maxDepth;
       
       if (isTargetCol) {
          // Sort by target order if it's a target, else append
          stepsAtCol.sort((a, b) => {
             const oa = targetOrder.get(a.id) ?? 999;
             const ob = targetOrder.get(b.id) ?? 999;
             return oa - ob;
          });
       } else {
          // Sort by barycenter of the nodes it feeds
          stepsAtCol.sort((a, b) => {
             const getOutBarycenter = (step: Step): number => {
                if (!step.parents) return currentOutputY;
                let sum = 0, count = 0;
                for (const p of Object.keys(step.parents)) {
                    if (p === '') continue;
                    if (stepCenterY.has(p)) {
                        sum += stepCenterY.get(p)!;
                        count++;
                    }
                }
                return count > 0 ? sum / count : currentOutputY;
             };
             return getOutBarycenter(a) - getOutBarycenter(b);
          });
       }

       const blocks: { steps: { step: Step; idealY: number; height: number }[] }[] = [];

       for (const step of stepsAtCol) {
          const numMachines = Math.ceil(step.machines?.toNumber() ?? 0);
          const height = data.machineRecord[step.recipeSettings?.machineId ?? '']?.size?.[1] ?? 3;
          const stepHeightTotal = numMachines * height;
          
          // eslint-disable-next-line no-useless-assignment
          let idealY = 0;
          if (isTargetCol) {
              idealY = currentOutputY;
              currentOutputY += stepHeightTotal + (isSpacePlatformLayout ? 0 : 10); // Extra gap for different outputs
          } else {
             // Barycenter
             let sum = 0, count = 0;
             if (step.parents) {
                 for (const p of Object.keys(step.parents)) {
                     if (p !== '' && stepCenterY.has(p)) {
                         sum += stepCenterY.get(p)!;
                         count++;
                     }
                 }
             }
             const bary = count > 0 ? sum / count : currentOutputY;
             idealY = bary - stepHeightTotal / 2;
          }

          let b = { steps: [{ step, idealY, height: stepHeightTotal }] };
          
          while (blocks.length > 0) {
              const prev = blocks[blocks.length - 1];
              
              let prevSum = 0;
              let prevOffset = 0;
              for (const s of prev.steps) {
                  prevSum += s.idealY - prevOffset;
                  prevOffset += s.height + (isSpacePlatformLayout ? 0 : 2);
              }
              const prevStartY = prevSum / prev.steps.length;
              
              let bSum = 0;
              let bOffset = 0;
              for (const s of b.steps) {
                  bSum += s.idealY - bOffset;
                  bOffset += s.height + (isSpacePlatformLayout ? 0 : 2);
              }
              const bStartY = bSum / b.steps.length;
              
              if (prevStartY + prevOffset > bStartY + 0.001) {
                  prev.steps.push(...b.steps);
                  blocks.pop();
                  b = prev;
              } else {
                  break;
              }
          }
          blocks.push(b);
       }

       let floorY = 0;
       for (const b of blocks) {
           let sum = 0;
           let offset = 0;
           for (const s of b.steps) {
               sum += s.idealY - offset;
               offset += s.height + (isSpacePlatformLayout ? 0 : 2);
           }
           let currentY = sum / b.steps.length;
           
           currentY = Math.max(floorY, currentY);
           
           for (const s of b.steps) {
               if (s.step.id) {
                   stepCenterY.set(s.step.id, currentY + s.height / 2);
               }
               currentY += s.height + (isSpacePlatformLayout ? 0 : 2);
           }
           
           floorY = currentY;
       }
    }

    // 4. Entity Placement
    const placedBeacons = new Set<string>();

    // Now place machines and beacons exactly at their coordinates
    for (const step of targetSteps) {
        const colKey = stepColKey.get(step.id ?? '');
        if (!colKey) continue;
        const i = colKeys.indexOf(colKey);
        if (i === -1) continue;
        const isTargetCol = colKeysArr[i].depth === maxDepth;

        const mX = machineColX.get(i) ?? 0;
        let cY = (stepCenterY.get(step.id) ?? 0) - (Math.ceil(step.machines?.toNumber() ?? 0) * (data.machineRecord[step.recipeSettings?.machineId ?? '']?.size?.[1] ?? 3)) / 2;
        const blockStartY = cY;

        const recipeId = step.recipeId;
        const recipeSettings = step.recipeSettings;
        if (!recipeId || !recipeSettings?.machineId) continue;

        const machineIdStr = recipeSettings.machineId;
        const { baseId: machineBaseId, level: machineQualityLevel } = this.parseQualityId(machineIdStr);
        const machineRecord = data.machineRecord[machineIdStr];
        const width = machineRecord?.size?.[0] ?? 3;
        const height = machineRecord?.size?.[1] ?? 3;

        const numMachines = Math.ceil(step.machines?.toNumber() ?? 0);
        const { baseId: recipeBaseId, level: recipeQualityLevel } = this.parseQualityId(recipeId);
        const machineModulesPlan = this.generateInsertPlan(recipeSettings.modules, recipeSettings.machineId) ?? [];

        let stepNumBeacons = 0;
        let beaconModulesPlan: BlueprintInsertPlan[] = [];
        let beaconBaseId = '';
        let beaconQualityLevel = 0;
        let bWidth = 3;
        let bHeight = 3;

        const beacons = recipeSettings.beacons ?? [];
        const foundBeacon = beacons.find(b => b.id && b.count && !b.count.isZero());
        if (foundBeacon?.id && numMachines > 0) {
          stepNumBeacons = Math.ceil((foundBeacon.total ?? foundBeacon.count ?? rational.zero).toNumber());
          const parsed = this.parseQualityId(foundBeacon.id);
          beaconBaseId = parsed.baseId;
          beaconQualityLevel = parsed.level ?? 0;
          const beaconRecord = data.beaconRecord[foundBeacon.id];
          bWidth = beaconRecord?.size?.[0] ?? 3;
          bHeight = beaconRecord?.size?.[1] ?? 3;
          beaconModulesPlan = this.generateInsertPlan(foundBeacon.modules, foundBeacon.id) ?? [];
        }

        // Output Panels (for depth 0 outputs)
        if (!isSpacePlatformLayout && step.id && step.parents?.[''] && !step.parents[''].isZero()) {
           const fraction = step.parents[''].toNumber();
           const targetBelts = step.belts ? step.belts.toNumber() * fraction : 0;
           const isFluid = !data.itemRecord[step.itemId!]?.stack;
           const tag = isFluid ? 'fluid' : 'item';
           let text = '';
           if (targetBelts > 0.01 && !isFluid) {
              text = `[${tag}=${step.itemId || ''}] Out: ${Math.round(targetBelts * 100) / 100} belts`;
           } else if (step.items) {
              text = `[${tag}=${step.itemId || ''}] Out: ${Math.round(step.items.toNumber() * fraction * 10) / 10}/m`;
           }
           if (text) {
              entities.push({
                entity_number: entity_number++,
                name: 'display-panel',
                position: { x: (isTargetCol ? farRightBeaconX + 5 : mX + 5), y: blockStartY },
                text: text,
                icon: { name: step.itemId!, type: isFluid ? 'fluid' : 'item' },
                always_show: true,
                show_in_chart: true
              });
           }
        }

        // Input panels for raw materials
        const incomingForGatherer = incomingEdges.get(step.id ?? '') ?? [];
        if (!isSpacePlatformLayout && incomingForGatherer.length === 0 && step.itemId) {
           const beltsRequired = step.belts ? step.belts.toNumber() : 0;
           const isFluid = !data.itemRecord[step.itemId]?.stack;
           const tag = isFluid ? 'fluid' : 'item';
           let text = '';
           if (beltsRequired > 0.01 && !isFluid) {
              text = `[${tag}=${step.itemId || ''}] Expected: ${Math.round(beltsRequired * 100) / 100} belts`;
           } else if (step.items) {
              const itemsReq = step.items.toNumber();
              if (itemsReq > 0.01) text = `[${tag}=${step.itemId || ''}] Expected: ${Math.round(itemsReq * 10) / 10}/m`;
           }
           if (text && numMachines > 0) {
              text += `\n[entity=${machineBaseId}] ${numMachines}`;
           }
           if (text) {
              entities.push({
                 entity_number: entity_number++,
                 name: 'display-panel',
                 position: { x: mX - 1.5, y: blockStartY + height / 2 },
                 text: text,
                 icon: { name: step.itemId, type: isFluid ? 'fluid' : 'item' },
                 always_show: true,
                 show_in_chart: true
              });
           }
        }

        // Place Machines
        const maxColWidth = maxMachineWidthAtDepth.get(i) ?? width;
        for (let j = 0; j < numMachines; j++) {
           entities.push({
             entity_number: entity_number++,
             name: machineBaseId,
             position: { x: mX + maxColWidth / 2, y: cY + height / 2 },
             recipe: recipeBaseId,
             recipe_quality: getQualityString(recipeQualityLevel),
             quality: getQualityString(machineQualityLevel),
             items: machineModulesPlan,
           });
           cY += height;
        }

        // Place Beacons (Left and Right)
        if (stepNumBeacons > 0) {
           const bXLeft = beaconColX.get(i) ?? 0;
           const bXRight = (i === colKeys.length - 1) ? farRightBeaconX : (beaconColX.get(i + 1) ?? 0);
           
           const machinesCenterY = stepCenterY.get(step.id) ?? 0;
           
           const beaconsLeft = Math.ceil(stepNumBeacons / 2);
           const beaconsRight = Math.floor(stepNumBeacons / 2);

           const placeBeacons = (bX: number, numB: number): void => {
              if (numB <= 0) return;
              const by = machinesCenterY - (numB * bHeight) / 2;
              let snappedBy = Math.round(by / bHeight) * bHeight;
              for (let j = 0; j < numB; j++) {
                 // Ignore if not overlapping machines vertically
                 const beaconEffectTop = snappedBy - 3;
                 const beaconEffectBottom = snappedBy + bHeight + 3;
                 const machinesTop = blockStartY;
                 const machinesBottom = blockStartY + (numMachines * height);
                 
                 if (beaconEffectBottom >= machinesTop && beaconEffectTop <= machinesBottom) {
                    const beaconKey = `${bX},${snappedBy}`;
                    if (!placedBeacons.has(beaconKey)) {
                       placedBeacons.add(beaconKey);
                       entities.push({
                         entity_number: entity_number++,
                         name: beaconBaseId,
                         position: { x: bX + bWidth / 2, y: snappedBy + bHeight / 2 },
                         quality: getQualityString(beaconQualityLevel),
                         items: beaconModulesPlan,
                       });
                    }
                 }
                 snappedBy += bHeight;
              }
           };

           placeBeacons(bXLeft, beaconsLeft);
           placeBeacons(bXRight, beaconsRight);
        }
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

    const blueprintData: IBlueprintData = {
      blueprint: {
        version: FACTORIO_2_1_VERSION,
        item: 'blueprint',
        label: 'FactorioLab Export',
        icons,
        entities,
      },
    };

    return this.encodeBlueprintString(blueprintData);
  }

  private parseQualityId(id: string): { baseId: string; level?: number } {
    const match = QUALITY_REGEX.exec(id);
    if (match) {
      return { baseId: match[1], level: parseInt(match[2], 10) };
    }
    return { baseId: id };
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
