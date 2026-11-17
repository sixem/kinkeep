import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const sandbox={ URL };vm.runInNewContext(readFileSync(new URL('../media-candidates.js',import.meta.url),'utf8'),sandbox);
const create = () => {
 const photo={complete:true,naturalWidth:683,naturalHeight:1024,src:'https://img.kindroid.ai/path/pic.webp',getBoundingClientRect:()=>({width:200,height:300}),parentElement:{classList:[]}};
 const avatar={...photo,src:'https://img.kindroid.ai/avatar.jpg',parentElement:{classList:['abc_avatar-media']}};
 const document={images:[photo,avatar],defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})}};
 const item={id:'s1',timestamp:1770000000000,thumbnailUrl:'path/pic.webp',prompt:'sample',chat_message_id:'m1'};
 const caches=[{ownerUid:'u',client:{clientState:{queries:[{queryKey:['v2','user','u'],state:{data:{aiList:['k']}}},{queryKey:['v2','selfies','u','k','ai',1,null,null,1],state:{data:[item]}}]}}}];
 return {document,caches,item};
};
test('maps only loaded visible gallery previews and the active Kin portrait',()=>{const x=create(),found=sandbox.KinexportMediaCandidates.read('u',x.caches,'/v2/chat/k',x.document);assert.equal(found.length,2);assert.equal(found[0].sourceId,'s1');assert.equal(found[0].variant,'preview');assert.equal(found[0].messageId,'m1');assert.equal(found[1].variant,'avatar');});
test('does not guess ownership, time or ambiguous images',()=>{const x=create();assert.equal(sandbox.KinexportMediaCandidates.read('other',x.caches,'/v2/chat/k',x.document).length,0);x.item.timestamp=1;assert.equal(sandbox.KinexportMediaCandidates.read('u',x.caches,'/v2/chat/k',x.document).length,1);x.item.timestamp=1770000000000;x.document.images.push({...x.document.images[0]});assert.equal(sandbox.KinexportMediaCandidates.read('u',x.caches,'/v2/chat/k',x.document).length,1);});
test('does not collect image URLs containing credentials',()=>{const x=create();x.document.images[0].src='https://user:secret@img.kindroid.ai/path/pic.webp';const found=sandbox.KinexportMediaCandidates.read('u',x.caches,'/v2/chat/k',x.document);assert.equal(found.length,1);assert.equal(found[0].kind,'portrait');});
