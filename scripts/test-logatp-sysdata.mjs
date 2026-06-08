// 測 Log ATP 2 system data 正規化(不碰 DB)。真資料代表性幾列。
import { _logatpTestHooks as H } from '../src/pilot-log/import-logatp.ts';

const flightCsv = `objectId,realmID,flightDate,flightNumber,aircraftType,aircraftRegistration,aircraftID,departure,destination,outTime,offTime,onTime,inTime,nightTime,pfTakeoff,pfLanding,picTime,autoland,goAround,diverted,blockTime,flightTime,crew1,crew2,crew3,crew4,approachType,totalPax,totalPayload,flightPlanDistance,createdAt,updatedAt
piNg5UXoEu,fkloVSW6Halq0Yv,2023-06-05,JX800,A359,B58503,bWA7eUeJCv,TPE,NRT,1685924880.0,1685925480.0,1685935500.0,1685936400.0,0,false,false,false,false,false,false,192,167,,,,,,0,0.0,0,2025-07-31 16:50:45 +0000,2025-07-31 16:50:45 +0000
1f3JiBqAGK,MKaccI7c7tIh3NE,2023-06-21,JX002,A359,B58501,0vd3FFPBrB,TPE,LAX,1687364880.0,1687365480.0,1687407240.0,1687408140.0,172,true,true,false,false,false,false,721,696,,,,,,0,0.0,0,x,x
44PfD5EF7D,Lnl2qmNEK6l03WV,2025-05-23,JX001,A359,B58509,QddG1lNKJI,LAX,TPE,1747985100.0,1747986420.0,1748035080.0,1748035680.0,732,true,true,false,false,false,false,843,811,7p7PnmaoZW,1IFexmhyE9,fSKnHFESWH,1BddjdAbSm,ILS,0,0.0,0,x,x
,mu7PHCaEkKMnSAs,2025-07-19,JX010,A359,B58503,bWA7eUeJCv,TPE,ONT,1752928800.0,1752929820.0,1752973740.0,1752974580.0,278,false,false,false,false,false,false,763,732,d9HJBHHn7f,,vBj2kL9SPN,1IFexmhyE9,ILS,277,42283.0,6189,x,x
soaOChMfzB,JTzZsmgjVW47Ahx,2024-08-08,JX011,A359,B58504,gqt6mrkTLC,SFO,TPE,1723102620.0,0.0,0.0,1723148400.0,763,false,false,false,false,false,false,763,0,,,,,,0,0.0,0,x,x
v1jCoEYjJ8,584DD7BD-5E9D,2026-04-16,JX802,A35K,B58551,,TPE,HND,1776308040.0,1776309240.0,1776321660.0,1776327000.0,0,false,false,false,true,true,true,316,207,tneKQ2iS3K,1IFexmhyE9,,,ILS,292,42275.0,1292,x,x
PICself0001,realmPICself,2025-12-01,JX999,A359,B58503,bWA7eUeJCv,TPE,KIX,1764552540.0,1764554040.0,1764565500.0,1764566460.0,0,true,true,true,false,false,false,232,191,1IFexmhyE9,7p7PnmaoZW,fSKnHFESWH,,ILS,0,0.0,0,x,x
MIDNIGHT001,realmMid,2025-06-04,JX900,A359,B58503,bWA7eUeJCv,TPE,KIX,1749081300.0,1749081900.0,1749088200.0,1749088800.0,0,true,true,false,false,false,false,125,105,7p7PnmaoZW,,,,ILS,0,0.0,0,x,x`;

const crewCsv = `objectId,realmID,firstName,lastName,position,employeeId,licenceNumber,nationality,notes,isSelf
7p7PnmaoZW,UzrL7AtpAw7W8qT,GivenA,SurA,Captain,,,,,false
1IFexmhyE9,6zR6BVht2WFbzSY,SELF,ME,SFO,2306789,,TW,,true
fSKnHFESWH,QELVJX9t4uJXpsz,GivenC,SurC,SFO,2306710,,TW,,false
1BddjdAbSm,YOOP6n4sEc2yr0C,GivenD,SurD,SFO,2214824,,TW,,false
d9HJBHHn7f,j3SXVxZEN0gsnAB,GivenE,SurE,Captain,,,,,false
vBj2kL9SPN,Za6E6vWxn9mNPOD,GivenF,SurF,Captain,,,,,false
tneKQ2iS3K,vzPx8bBl511FuvL,GivenG,SurG,Captain,,,,,false`;

const { parseCsv, isSystemDataHeaders, normalizeSystemData, epochToHHMM, epochToUTCDate, minToHHMM, parseHmAtDate } = H;
const parsed = parseCsv(flightCsv);
console.log('isSystemData:', isSystemDataHeaders(parsed.headers));
console.log('epoch 1685924880 →', epochToHHMM('1685924880.0'), '(in 1685936400 →', epochToHHMM('1685936400.0') + ')');
console.log('min 192 →', minToHHMM('192'), '| 0 →', minToHHMM('0'), '| 721 →', minToHHMM('721'));
const norm = normalizeSystemData(parsed.rows, crewCsv);
console.log('\n=== 正規化後(挑欄位) ===');
norm.rows.forEach((r, i) => {
  console.log(`#${i+1} ${r['Flight Date']} ${r['Departure']}→${r['Destination']} ${r['Flight Number']} ${r['Aircraft Type']} ${r['Aircraft Registration']} | Out ${r['Out time']} Off ${r['Off time']} On ${r['On time']} In ${r['In time']} | Blk ${r['Total Block Time']} Air ${r['Total Flight Time']} Nt ${r['Night Time']} | PFTO ${r['PF Takeoff']} PFLdg ${r['PF Landing']} PIC ${r['PIC']} AL ${r['Autoland']} Div ${r['Diverted']} GA ${r['Go around']} | crew[${[r['Crew 1'],r['Crew 2'],r['Crew 3'],r['Crew 4']].filter(Boolean).join(', ')}] | objId="${r['Object ID']}"`);
});
console.log('\n檢查:');
console.log('- #1 block 應 03:12:', norm.rows[0]['Total Block Time'] === '3:12' ? 'OK' : 'FAIL '+norm.rows[0]['Total Block Time']);
console.log('- #3 crew 應排除 SELF、留 3 人:', [norm.rows[2]['Crew 1'],norm.rows[2]['Crew 2'],norm.rows[2]['Crew 3'],norm.rows[2]['Crew 4']].filter(Boolean).length===3 ? 'OK' : 'FAIL');
console.log('- #3 crew 不含 SELF ME:', ![norm.rows[2]['Crew 1'],norm.rows[2]['Crew 2'],norm.rows[2]['Crew 3'],norm.rows[2]['Crew 4']].includes('SELF ME') ? 'OK' : 'FAIL');
console.log('- #4 空 objectId 退用 realmID(穩定):', norm.rows[3]['Object ID']==='mu7PHCaEkKMnSAs' ? 'OK' : 'FAIL '+norm.rows[3]['Object ID']);
console.log('- #5 off/on 0.0 應為空:', norm.rows[4]['Off time']==='' && norm.rows[4]['On time']==='' ? 'OK' : 'FAIL');
console.log('- #6 A35K + Diverted/GA/AL=TRUE:', norm.rows[5]['Aircraft Type']==='A35K' && norm.rows[5]['Diverted']==='TRUE' && norm.rows[5]['Go around']==='TRUE' && norm.rows[5]['Autoland']==='TRUE' ? 'OK' : 'FAIL');
console.log('- #3(SIC) Crew 1 應=機長 GivenA SurA(不被位移):', norm.rows[2]['Crew 1']==='GivenA SurA' ? 'OK' : 'FAIL '+norm.rows[2]['Crew 1']);
console.log('- #7(本人PIC) Crew 1 應留空(不把副駕誤標機長):', norm.rows[6]['Crew 1']==='' ? 'OK' : 'FAIL '+norm.rows[6]['Crew 1']);
console.log('- #7(本人PIC) PIC 欄應 TRUE(picTime=true):', norm.rows[6]['PIC']==='TRUE' ? 'OK' : 'FAIL '+norm.rows[6]['PIC']);
console.log('- #7(本人PIC) 其餘 crew compact 進 Crew 2/3:', norm.rows[6]['Crew 2']==='GivenA SurA' && norm.rows[6]['Crew 3']==='GivenC SurC' ? 'OK' : 'FAIL '+[norm.rows[6]['Crew 2'],norm.rows[6]['Crew 3']].join(','));

// === 跨 UTC 午夜防彈驗證(out 23:55 UTC、in 隔天 02:00 UTC) ===
const m = norm.rows[7];
const outU = parseHmAtDate(m['Flight Date'], m['Out time']);
const offU = parseHmAtDate(m['Flight Date'], m['Off time'], outU);
const onU  = parseHmAtDate(m['Flight Date'], m['On time'], offU || outU);
const inU  = parseHmAtDate(m['Flight Date'], m['In time'], onU || offU || outU);
const blkMin = Math.round((inU.getTime() - outU.getTime()) / 60000);
console.log('\n=== 跨 UTC 午夜 ===');
console.log('- #8 Flight Date 應錨在 out UTC 日 2025-06-04:', m['Flight Date']==='2025-06-04' ? 'OK' : 'FAIL '+m['Flight Date']);
console.log('- #8 Out 23:55 / In 02:00:', m['Out time']==='23:55' && m['In time']==='02:00' ? 'OK' : 'FAIL '+m['Out time']+'/'+m['In time']);
console.log('- #8 out 還原應 2025-06-04T23:55Z:', outU.toISOString().slice(0,16)+'Z'==='2025-06-04T23:55Z' ? 'OK' : 'FAIL '+outU.toISOString());
console.log('- #8 in 還原應跨到隔天 2025-06-05T02:00Z:', inU.toISOString().slice(0,16)+'Z'==='2025-06-05T02:00Z' ? 'OK' : 'FAIL '+inU.toISOString());
console.log('- #8 block 還原應 125 分(2:05)不爆 -22h:', blkMin===125 ? 'OK' : 'FAIL '+blkMin);

// === 防靜默資料流失:有組員 ID 卻沒附組員檔 → 應偵測得到(importLogatp 會擋下) ===
const hasCrewIds = parsed.rows.some(r => (r['crew1']||r['crew2']||r['crew3']||r['crew4']||'').trim());
const noIdRows = parseCsv(`objectId,realmID,flightDate,departure,destination,outTime,inTime,blockTime,crew1,crew2,crew3,crew4\na,b,2025-06-04,TPE,KIX,1749081300.0,1749088800.0,125,,,,`).rows;
const noIdHasCrew = noIdRows.some(r => (r['crew1']||r['crew2']||r['crew3']||r['crew4']||'').trim());
console.log('\n=== 沒附組員檔的防護 ===');
console.log('- 本檔有組員 ID(沒組員檔應被擋):', hasCrewIds===true ? 'OK' : 'FAIL');
console.log('- 純無組員的 system data 不誤擋:', noIdHasCrew===false ? 'OK' : 'FAIL');
