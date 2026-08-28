import { TestBed } from '@angular/core/testing';

import { rational } from '~/rational/rational';
import { Step } from '~/solver/step';
import { initialColumnsState } from '~/state/preferences/columns-state';
import { ItemId } from '~/tests/item-id';
import { Mocks } from '~/tests/mocks/mocks';
import { RecipeId } from '~/tests/recipe-id';
import { TestModule } from '~/tests/test-module';

import { Exporter } from './exporter';

describe('Exporter', () => {
  let service: Exporter;
  let mocks: Mocks;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TestModule] });
    service = TestBed.inject(Exporter);
    mocks = TestBed.inject(Mocks);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('stepsToCsv', () => {
    it('should save the csv', () => {
      spyOn<any>(service, 'saveAsCsv');
      service.stepsToCsv(mocks.steps());
      expect(service['saveAsCsv']).toHaveBeenCalled();
    });
  });

  describe('flowToJson', () => {
    it('should save the json', () => {
      spyOn<any>(service, 'saveAsJson');
      service.flowToJson(mocks.flow());
      expect(service['saveAsJson']).toHaveBeenCalled();
    });
  });

  describe('stepToJson', () => {
    const itemId = ItemId.IronPlate;
    const recipeId = RecipeId.IronPlate;
    const inStep: Step = {
      id: '0',
      itemId: ItemId.IronOre,
      recipeId: RecipeId.IronPlate,
      parents: { ['1']: rational.one },
    };
    const fullStep: Step = {
      id: '1',
      itemId,
      items: rational(3n),
      surplus: rational(2n),
      belts: rational(3n),
      wagons: rational(4n),
      rockets: rational(1n, 2n),
      machines: rational(5n),
      power: rational(6n),
      pollution: rational(7n),
      outputs: { [itemId]: rational(8n) },
      parents: { ['1']: rational(9n) },
      recipeId,
    };
    const minStep: Step = {
      id: '2',
      itemId: itemId,
      recipeId: recipeId,
    };

    it('should fill in all fields', () => {
      spyOn<any>(service, 'columnsState').and.returnValue({
        ...initialColumnsState,
        rockets: { show: true },
      });
      const result = service['stepToJson'](fullStep, [inStep, fullStep]);
      expect(result).toEqual({
        Item: itemId,
        Items: '=1',
        Surplus: '=2',
        Inputs: '"iron-ore:1"',
        Outputs: '"iron-plate:8"',
        Targets: '"iron-plate:9"',
        Belts: '=3',
        Belt: ItemId.TransportBelt,
        Wagons: '=4',
        Wagon: ItemId.CargoWagon,
        Rockets: '=0.5',
        Recipe: recipeId,
        Machines: '=5',
        Machine: ItemId.ElectricFurnace,
        Modules: `"2 ${ItemId.ProductivityModule3}"`,
        Beacons: `"8 ${ItemId.Beacon} (2 ${ItemId.SpeedModule3})"`,
        Power: '=6',
        Pollution: '=7',
      });
    });

    it('should handle empty fields', () => {
      const result = service['stepToJson'](minStep, [minStep]);
      expect(result).toEqual({
        Item: itemId,
        Belt: ItemId.TransportBelt,
        Wagon: ItemId.CargoWagon,
        Recipe: recipeId,
        Machine: ItemId.ElectricFurnace,
        Modules: `"2 ${ItemId.ProductivityModule3}"`,
        Beacons: `"8 ${ItemId.Beacon} (2 ${ItemId.SpeedModule3})"`,
      });
    });
  });

  describe('exportToBlueprint', () => {
    
    it('should generate inputBelts correctly for solid and fluid items', async () => {
      const generateSpy = spyOn(service['blueprintService'], 'generateBlueprintFromSteps').and.returnValue(Promise.resolve('0eTest'));
      spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());

      const data = service['data']();
      // Make sure we have mock data
      data.itemRecord['iron-plate'] = { stack: 100 } as any;
      data.itemRecord['water'] = { stack: undefined } as any;
      data.beltIds = ['transport-belt', 'fast-transport-belt'];

      spyOn(service as any, 'itemsState').and.returnValue({
          'iron-plate': { beltId: 'fast-transport-belt' }
      } as any);

      // Create mock steps:
      const steps = [
        {
          id: '1',
          itemId: 'iron-plate',
          belts: rational(2.5),
        },
        {
          id: '2',
          itemId: 'water',
          belts: rational(1.2),
        },
        {
          id: '3',
          itemId: 'iron-plate',
          belts: rational(0.5), // Combines with step 1 to make 3 belts
        },
        {
          id: '4', // Missing itemId
          belts: rational(2),
        },
        {
          id: '5',
          itemId: 'copper-plate',
          belts: undefined, // Missing belts
        },
        {
          id: '6',
          itemId: 'copper-cable',
          belts: rational(0.5), // < 1 belt, so should be ignored
        }
      ] as any[];

      await service.exportToBlueprint(steps);

      expect(generateSpy).toHaveBeenCalled();
      const inputBeltsArg = generateSpy.calls.mostRecent().args[2];
      expect(inputBeltsArg!.length).toBe(2);
      
      const ironPlate = inputBeltsArg!.find((b: any) => b.itemId === 'iron-plate');
      expect(ironPlate).toEqual({ beltId: 'fast-transport-belt', itemId: 'iron-plate', count: 3 });

      const water = inputBeltsArg!.find((b: any) => b.itemId === 'water');
      expect(water).toEqual({ beltId: 'pump', itemId: 'water', count: 2 });
    });

    it('should call blueprintService and write to clipboard', async () => {
      const generateSpy = spyOn(service['blueprintService'], 'generateBlueprintFromSteps').and.returnValue(Promise.resolve('0eTest'));
      const writeTextSpy = spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());

      await service.exportToBlueprint([]);

      expect(generateSpy).toHaveBeenCalled();
      expect(writeTextSpy).toHaveBeenCalledWith('0eTest');
    });
  });
});
