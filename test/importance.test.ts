import {describe,it,expect} from 'vitest';
import {extractImportance,validateImportance,getImportance} from '../src/importance';
describe('grounded context',()=>{
 it('requires a complete short verbatim sentence',()=>{
  expect(extractImportance('The bureau approved the proposal. More details follow.').text).toBe('The bureau approved the proposal.');
  expect(validateImportance('Prices will fall.','The bureau approved the proposal.')).toBe(false);
  expect(extractImportance('').text).toBe('');
  expect(extractImportance('a'.repeat(141)+'.').text.length).toBeLessThanOrEqual(140);
  expect(extractImportance('<script>alert(1)</script>.').text).toBe('');
 });
 it('rejects invented AI claims and caches fallback',async()=>{
  let cached:any=null,calls=0;
  const env:any={DB:{prepare:()=>({bind:()=>({first:async()=>cached,run:async()=>{cached={text:'The vote was held.',method:'extractive'};}})})},AI:{run:async()=>{calls++;return {response:'Taxes will fall.'};}}};
  expect((await getImportance(env,'The vote was held.')).text).toBe('The vote was held.');
  await getImportance(env,'The vote was held.'); expect(calls).toBe(1);
 });
});
