import {it,expect} from 'vitest';
import {currentItem,repairNimbTitle} from '../src/current-item';
it('repairs money and possessives only for manual NIMB headlines',()=>{
 expect(repairNimbTitle('Palmas Athletic Club UBS seek 46 4m consent judgment')).toBe('Palmas Athletic Club UBS seek $46.4m consent judgment');
 expect(repairNimbTitle('Puerto ricos new opportunity zone map shrinks by nearly 80')).toBe('Puerto Rico’s new opportunity zone map shrinks by nearly 80%');
 const item:any={url:'https://example.org/a',title:'Puerto ricos 46 4m',source:'endi',reason:'manual-import',titleOrigin:'url-slug',summary:'',section:'negocios'};
 expect(currentItem(item).title).toBe(item.title);
 expect(currentItem({...item,source:'nimb'}).title).toBe('Puerto Rico’s $46.4m');
 expect(repairNimbTitle('$46.4m')).toBe('$46.4m');
});
