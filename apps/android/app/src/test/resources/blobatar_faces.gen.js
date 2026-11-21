const fs=require('fs');
eval(fs.readFileSync(process.argv[2],'utf8'));
const seeds=["new-bot","3f0c2a9e-1b2c-4d5e-8f90-123456789abc","Dray Bot","a","9d3e5a1c-0000-4000-8000-000000000001","ÄÖü-Ω","bot-xyz"];
const out=[];
for (const s of seeds){ out.push([s,null,botFace(s,null,64)]); }
for (const [sh] of [["round"],["organic"],["boxy"],["capsule"],["nub"],["cloud"],["hexagon"],["sun"],["triangle"]]) for (const h of [25,145,250,340]) out.push(["new-bot",{shape:sh,hue:h},botFace("new-bot",{shape:sh,hue:h},64)]);
console.log(JSON.stringify(out));
