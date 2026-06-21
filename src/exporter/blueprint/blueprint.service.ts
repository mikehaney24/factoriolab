import { Injectable } from '@angular/core';

import { Dataset } from '~/state/settings/dataset';
import { Step } from '~/solver/step';
import { QUALITY_REGEX } from '~/data/schema/quality';
import { notNullish } from '~/utils/nullish';
import { rational } from '~/rational/rational';

import {
  BlueprintInsertPlan,
  IBlueprintData,
  IEntity,
  IIcon,
  ISignal,
  getQualityString,
} from './blueprint-types';

export const FACTORIO_2_0_VERSION = 562949956370432; // Factorio 2.0.45.0

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
    for (let i = 0; i < compressedBytes.length; i++) {
      binaryString += String.fromCharCode(compressedBytes[i]);
    }
    return '0' + btoa(binaryString);
  }

  async generateBlueprintFromSteps(steps: Step[], data: Dataset): Promise<string> {
    const entities: IEntity[] = [];
    let entity_number = 1;

    // Calculate target width for a 16:9 aspect ratio blueprint
    let totalArea = 0;
    for (const step of steps) {
      if (step.machines == null || step.machines.isZero()) continue;
      const recipeSettings = step.recipeSettings;
      if (!recipeSettings || !recipeSettings.machineId) continue;

      const machineIdStr = recipeSettings.machineId;
      const machineRecord = data.machineRecord[machineIdStr];
      const width = machineRecord?.size?.[0] ?? 3;
      const height = machineRecord?.size?.[1] ?? 3;
      const numMachines = Math.ceil(step.machines.toNumber());
      totalArea += numMachines * (width + 1) * (height + 1);

      if (recipeSettings.beacons) {
        for (const beaconSettings of recipeSettings.beacons) {
          if (!beaconSettings.id || !beaconSettings.count || beaconSettings.count.isZero()) continue;
          const numBeacons = Math.ceil((beaconSettings.total ?? beaconSettings.count).toNumber());
          const beaconRecord = data.beaconRecord[beaconSettings.id];
          const bWidth = beaconRecord?.size?.[0] ?? 3;
          const bHeight = beaconRecord?.size?.[1] ?? 3;
          totalArea += numBeacons * (bWidth + 1) * (bHeight + 1);
        }
      }
    }

    const targetWidth = Math.max(30, Math.ceil(Math.sqrt(totalArea * 16 / 9)));

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
         incomingEdges.get(parentId)!.push(step.id);
      }
    }

    // 2. Calculate Topological Depth
    const depths = new Map<string, number>();
    const calcDepth = (id: string, visited: Set<string>): number => {
      if (depths.has(id)) return depths.get(id)!;
      if (visited.has(id)) return 0; // Cycle detected
      visited.add(id);

      const incoming = incomingEdges.get(id) || [];
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

    // 3. Proportional Step Splitting (Top-Down by Depth)
    const fractionByTarget = new Map<string, Map<string, number>>();
    for (const step of steps) {
       if (step.id) fractionByTarget.set(step.id, new Map());
    }

    const targets: string[] = [];
    for (const step of steps) {
      if (!step.id || !step.parents) continue;
      if (step.parents[''] && !step.parents[''].isZero()) {
         fractionByTarget.get(step.id)!.set(step.id, step.parents[''].toNumber());
         targets.push(step.id);
      }
    }

    // Sort step IDs by depth descending
    const sortedStepIds = Array.from(stepMap.keys()).sort((a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0));

    for (const stepId of sortedStepIds) {
       const step = stepMap.get(stepId)!;
       const targetMap = fractionByTarget.get(stepId)!;
       
       if (step.parents) {
         for (const parentId of Object.keys(step.parents)) {
           if (parentId === '') continue;
           const consumerTargetMap = fractionByTarget.get(parentId);
           if (!consumerTargetMap) continue;
           
           const fractionGoingToConsumer = step.parents[parentId].toNumber();
           
           for (const [targetId, consumerFraction] of consumerTargetMap.entries()) {
              const currentFraction = targetMap.get(targetId) ?? 0;
              targetMap.set(targetId, currentFraction + (fractionGoingToConsumer * consumerFraction));
           }
         }
       }
    }

    // 4. Independent Row Layouts
    let globalY = 0;

    for (const targetId of targets) {
      const targetSteps: Step[] = [];
      for (const step of steps) {
         if (!step.id || step.machines == null || step.machines.isZero()) continue;
         const fraction = fractionByTarget.get(step.id)?.get(targetId) ?? 0;
         if (fraction > 0.0001) {
            targetSteps.push({
               ...step,
               machines: rational(Math.ceil(step.machines.toNumber() * fraction))
            });
         }
      }

      if (targetSteps.length === 0) continue;

      // Calculate Input and Output texts for the display panel
      const inputLines: string[] = [];
      const outputLines: string[] = [];
      let targetIcon: ISignal | undefined = undefined;

      const targetStep = stepMap.get(targetId);
      if (targetStep && targetStep.itemId) {
         targetIcon = { name: targetStep.itemId, type: data.itemRecord[targetStep.itemId]?.stack ? 'item' : 'fluid' };
         const fraction = targetStep.parents?.['']?.toNumber() ?? 1.0;
         const targetBelts = targetStep.belts ? targetStep.belts.toNumber() * fraction : 0;
         const isFluid = !data.itemRecord[targetStep.itemId]?.stack;
         const tag = isFluid ? 'fluid' : 'item';
         if (targetBelts > 0.01 && !isFluid) {
            outputLines.push(`[${tag}=${targetStep.itemId}] Out: ${Math.round(targetBelts * 100) / 100} belts`);
         } else if (targetStep.items) {
            outputLines.push(`[${tag}=${targetStep.itemId}] Out: ${Math.round(targetStep.items.toNumber() * fraction * 10) / 10}/m`);
         }
      }

      for (const step of steps) {
         if (!step.id) continue;
         const fraction = fractionByTarget.get(step.id)?.get(targetId) ?? 0;
         if (fraction > 0.0001) {
            if ((!step.machines || step.machines.isZero()) && step.itemId) {
               const beltsRequired = step.belts ? step.belts.toNumber() * fraction : 0;
               const isFluid = !data.itemRecord[step.itemId]?.stack;
               const tag = isFluid ? 'fluid' : 'item';
               if (beltsRequired > 0.01 && !isFluid) {
                  inputLines.push(`[${tag}=${step.itemId}] In: ${Math.round(beltsRequired * 100) / 100} belts`);
               } else if (step.items) {
                  const itemsReq = step.items.toNumber() * fraction;
                  if (itemsReq > 0) inputLines.push(`[${tag}=${step.itemId}] In: ${Math.round(itemsReq * 10) / 10}/m`);
               }
            }
         }
      }

      const panelText = [...outputLines, ...inputLines].join('\n');
      if (panelText) {
        entities.push({
          entity_number: entity_number++,
          name: 'display-panel',
          position: {
            x: -5,
            y: globalY + 1.5,
          },
          text: panelText,
          icon: targetIcon,
          always_show: true,
          show_in_chart: true
        });
      }

      const stepsByDepth: Record<number, Step[]> = {};
      for (const step of targetSteps) {
        const depth = depths.get(step.id!) ?? 0;
        if (!stepsByDepth[depth]) stepsByDepth[depth] = [];
        stepsByDepth[depth].push(step);
      }

      const depthKeys = Object.keys(stepsByDepth).map(Number).sort((a, b) => a - b);
      
      let currentX = 0;
      const stepCenterY = new Map<string, number>();
      let maxBandY = globalY;

      for (let dIndex = 0; dIndex < depthKeys.length; dIndex++) {
        const depth = depthKeys[dIndex];
        const depthSteps = stepsByDepth[depth];
        
        depthSteps.sort((a, b) => {
          const getBarycenter = (step: Step) => {
             const incoming = incomingEdges.get(step.id!) || [];
             let sum = 0, count = 0;
             for(const inc of incoming) {
                if (stepCenterY.has(inc)) {
                   sum += stepCenterY.get(inc)!;
                   count++;
                }
             }
             return count > 0 ? sum / count : globalY;
          };
          return getBarycenter(a) - getBarycenter(b);
        });

        let currentY = globalY;
        let colMaxWidth = 0;
        let maxColY = globalY;

        let beaconSetting = null;
        let beaconModulesPlan: BlueprintInsertPlan[] = [];
        let beaconBaseId = '';
        let beaconQualityLevel = 0;
        let bWidth = 3;
        let bHeight = 3;

        for (const step of depthSteps) {
          const recipeId = step.recipeId;
          const recipeSettings = step.recipeSettings;
          if (!recipeId || !recipeSettings || !recipeSettings.machineId) continue;

          const machineIdStr = recipeSettings.machineId;
          const { baseId: machineBaseId, level: machineQualityLevel } = this.parseQualityId(machineIdStr);
          
          const machineRecord = data.machineRecord[machineIdStr];
          const width = machineRecord?.size?.[0] ?? 3;
          const height = machineRecord?.size?.[1] ?? 3;

          const numMachines = Math.ceil(step.machines!.toNumber());
          let { baseId: recipeBaseId, level: recipeQualityLevel } = this.parseQualityId(recipeId);
          const machineModulesPlan = this.generateInsertPlan(recipeSettings.modules, recipeSettings.machineId) ?? [];

          if (!beaconSetting) {
            const beacons = recipeSettings.beacons || [];
            beaconSetting = beacons.find(b => b.id && b.count && !b.count.isZero());
            if (beaconSetting && beaconSetting.id) {
              const parsed = this.parseQualityId(beaconSetting.id);
              beaconBaseId = parsed.baseId;
              beaconQualityLevel = parsed.level ?? 0;
              const beaconRecord = data.beaconRecord[beaconSetting.id];
              bWidth = beaconRecord?.size?.[0] ?? 3;
              bHeight = beaconRecord?.size?.[1] ?? 3;
              beaconModulesPlan = this.generateInsertPlan(beaconSetting.modules, beaconSetting.id) ?? [];
            }
          }

          const incoming = incomingEdges.get(step.id!) || [];
          let sum = 0, count = 0;
          for (const inc of incoming) {
             if (stepCenterY.has(inc)) {
                sum += stepCenterY.get(inc)!;
                count++;
             }
          }
          const barycenter = count > 0 ? sum / count : globalY;
          const idealStartY = count > 0 ? barycenter - (numMachines * height) / 2 : currentY;
          
          if (idealStartY > currentY) {
             currentY = idealStartY; 
          }

          const blockStartY = currentY;

          const incomingForGatherer = incomingEdges.get(step.id!) || [];
          if (incomingForGatherer.length === 0 && step.itemId) {
             const fraction = fractionByTarget.get(step.id!)?.get(targetId) ?? 0;
             const beltsRequired = step.belts ? step.belts.toNumber() * fraction : 0;
             const isFluid = !data.itemRecord[step.itemId]?.stack;
             const tag = isFluid ? 'fluid' : 'item';
             let text = '';
             if (beltsRequired > 0.01 && !isFluid) {
                text = `[${tag}=${step.itemId}] Expected: ${Math.round(beltsRequired * 100) / 100} belts`;
             } else if (step.items) {
                const itemsReq = step.items.toNumber() * fraction;
                if (itemsReq > 0.01) text = `[${tag}=${step.itemId}] Expected: ${Math.round(itemsReq * 10) / 10}/m`;
             }
             if (text && numMachines > 0) {
                text += `\n[entity=${machineBaseId}] ${numMachines}`;
             }
             if (text) {
                entities.push({
                   entity_number: entity_number++,
                   name: 'display-panel',
                   position: {
                      x: currentX - 1.5,
                      y: blockStartY + height / 2,
                   },
                   text: text,
                   icon: { name: step.itemId, type: data.itemRecord[step.itemId]?.stack ? 'item' : 'fluid' },
                   always_show: true,
                   show_in_chart: true
                });
             }
          }

          let machinesPlaced = 0;
          while (machinesPlaced < numMachines) {
            const entity: IEntity = {
            entity_number: entity_number++,
            name: machineBaseId,
            position: {
              x: currentX + width / 2,
              y: currentY + height / 2,
            },
            recipe: recipeBaseId,
            recipe_quality: getQualityString(recipeQualityLevel),
            quality: getQualityString(machineQualityLevel),
            items: machineModulesPlan,
          };
          entities.push(entity);
          
          currentY += height; // 0 tile Y gap for vertical adjacency
          maxColY = Math.max(maxColY, currentY);
          colMaxWidth = Math.max(colMaxWidth, width);
          machinesPlaced++;
        }

        // Record the center Y of this step for its children to use
        stepCenterY.set(step.id!, blockStartY + (numMachines * height) / 2);
        
        // Add a small 2-tile gap between different steps in the same column
        currentY += 2;
      }

      // 6. Place a shared beacon column
      if (maxColY > globalY) {
        currentX += colMaxWidth + 2; // Move right by machine width + 2 tile gap
        
        if (beaconSetting && beaconSetting.id) {
          const numBeaconsToPlace = Math.max(1, Math.floor((maxColY - globalY) / bHeight));
          let by = globalY;
          for (let j = 0; j < numBeaconsToPlace; j++) {
            const entity: IEntity = {
              entity_number: entity_number++,
              name: beaconBaseId,
              position: {
                x: currentX + bWidth / 2,
                y: by + bHeight / 2,
              },
              quality: getQualityString(beaconQualityLevel),
              items: beaconModulesPlan,
            };
            entities.push(entity);
            by += bHeight;
          }
          currentX += bWidth + 2; // Move right by beacon width + 2 tile gap
        }
      }
      maxBandY = Math.max(maxBandY, maxColY);
      } // end depth loop
      
      globalY = maxBandY + 3; // 3 tile gap between independent target bands
    } // end target loop

    const icons: IIcon[] = [];
    const mainIconItem = steps.find(s => s.output && s.output.gt(rational.zero))?.itemId ?? steps[0]?.itemId;
    if (mainIconItem) {
      const { baseId: iconBaseId } = this.parseQualityId(mainIconItem);
      icons.push({
        index: 1,
        signal: { type: data.itemRecord[iconBaseId]?.stack ? 'item' : 'fluid', name: iconBaseId },
      });
    }

    const blueprintData: IBlueprintData = {
      blueprint: {
        version: FACTORIO_2_0_VERSION,
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

  private generateInsertPlan(modules: any[] | undefined, entityId: string): BlueprintInsertPlan[] | undefined {
    if (!modules || modules.length === 0) return undefined;

    // Determine module inventory index based on entity name heuristic
    let inventory = 4; // Default to crafter_modules (assembling-machine, furnace, etc)
    const lowerId = entityId.toLowerCase();
    if (lowerId.includes('beacon')) {
      inventory = 1;
    } else if (lowerId.includes('mining-drill') || lowerId.includes('pumpjack')) {
      inventory = 2;
    } else if (lowerId.includes('lab')) {
      inventory = 3;
    }

    const plan: BlueprintInsertPlan[] = [];
    let currentStack = 0;

    for (const mod of modules) {
      if (!mod.id || !mod.count || mod.count.isZero()) continue;

      const count = Math.ceil(mod.count.toNumber());
      const { baseId: modBaseId, level: modQualityLevel } = this.parseQualityId(mod.id);

      const in_inventory: any[] = [];
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
