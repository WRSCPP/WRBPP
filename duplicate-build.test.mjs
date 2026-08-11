import { duplicateSpec } from './dup.mjs';
let pass=0, fail=0;
const ok=(n,c)=>{ if(c) pass++; else { fail++; console.log('  FAIL', n); } };

// A build mid-production with real progress, the dangerous case to copy.
const src = {
  id:'mod-0101', name:'Ofland - Workforce Housing', client:'Ofland', moduleType:'Modular',
  lineId:'line-long', status:'active', priority:20, notes:'Rush job',
  targetShip:'2026-11-03', tentativeStart:'2026-08-10', confirmedStart:'2026-08-11',
  actualStart:'2026-08-11', actualShip:null,
  stageDurations:{s1:4,s2:6}, projectedHours:2022,
  stageProgress:{s1:1,s2:0.5}, stageHours:{s1:373,s2:98},
  stageActuals:{s1:{start:'2026-08-11',end:'2026-08-14'}},
  stageCrew:{s1:['p1','p2']}, inspectionStatus:{i1:'passed'},
  hoursUpdatedAt:'2026-08-04T12:00:00Z',
  materials:[{name:'Lumber pkg', qty:1}],
  attachments:{ plans:[{name:'plan.pdf', path:'x/y.pdf'}] },
  bays:[7,8], bay:7, needsFoam:true, needsTrailer:false,
};

const c = duplicateSpec(src, 2, 4);

console.log('SPEC carried over');
ok('client', c.client==='Ofland');
ok('moduleType', c.moduleType==='Modular');
ok('lineId', c.lineId==='line-long');
ok('targetShip', c.targetShip==='2026-11-03');
ok('priority', c.priority===20);
ok('notes', c.notes==='Rush job');
ok('projectedHours', c.projectedHours===2022);
ok('stageDurations copied', c.stageDurations.s1===4 && c.stageDurations.s2===6);
ok('stageDurations is a NEW object', c.stageDurations!==src.stageDurations);
ok('materials copied', c.materials.length===1 && c.materials[0].name==='Lumber pkg');
ok('materials deep-copied', c.materials[0]!==src.materials[0]);
ok('route stops copied', c.needsFoam===true && c.needsTrailer===false);

console.log('PROGRESS must NOT carry over');
ok('new id', c.id !== src.id && !!c.id);
ok('status resets to pipeline', c.status==='pipeline');
ok('no logged hours', Object.keys(c.stageHours).length===0);
ok('no stage progress', Object.keys(c.stageProgress).length===0);
ok('no stage actuals', Object.keys(c.stageActuals).length===0);
ok('no crew assignments', Object.keys(c.stageCrew).length===0);
ok('no inspection status', Object.keys(c.inspectionStatus).length===0);
ok('no hoursUpdatedAt', c.hoursUpdatedAt===null);
ok('no bay', c.bay===null && c.bays.length===0);
ok('no confirmedStart', c.confirmedStart===null);
ok('no actual dates', c.actualStart===null && c.actualShip===null);
ok('attachments NOT copied', Object.keys(c.attachments).length===0);

console.log('NAMING');
ok('numbered suffix', c.name==='Ofland - Workforce Housing (2 of 4)');
ok('single copy reads (copy)', duplicateSpec(src,1,1).name==='Ofland - Workforce Housing (copy)');
const again = duplicateSpec({...src, name:'Ofland - Workforce Housing (2 of 4)'}, 3, 5);
ok('copy of a copy does not stack suffixes', again.name==='Ofland - Workforce Housing (3 of 5)');
ok('untitled handled', duplicateSpec({}, 1, 2).name==='Untitled (1 of 2)');
const ids = new Set([1,2,3,4,5].map(i=>duplicateSpec(src,i,5).id));
ok('ids are unique across a batch', ids.size===5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
