
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).length <= limit;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validateApprovedPlanRef = value => {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['rootSessionId','objectiveId','sourceMessageId','version','phase','paths','content','contentHash'].includes(key))
    || !['rootSessionId','objectiveId','sourceMessageId'].every(key => text(value[key],256))
    || !digest(value.version) || !text(value.phase,512) || !text(value.content,32*1024)
    || !digest(value.contentHash)
    || !Array.isArray(value.paths) || value.paths.length > 32 || value.paths.some(item => !text(item,512)
      || /^(?:[\\/]|[a-zA-Z]:)/.test(item) || item.split(/[\\/]/).includes('..'))) throw new TypeError('Invalid approved plan reference');
};

// Use exact Markdown headings outside fences; never let a partial title or a
// code example silently select a different work unit.
export const scopedApprovedPlanContent = (content, phase) => {
  if (!text(phase,512) || !text(content,256*1024)) throw new TypeError('Invalid approved plan section');
  const lines=content.split(/\r?\n/), headings=[];
  let fence;
  lines.forEach((line,index)=>{
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=undefined;return;}
    const heading=!fence&&line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if(heading)headings.push({index,level:heading[1].length,title:heading[2]});
  });
  const matches=headings.filter(heading=>heading.title===phase);
  if(matches.length!==1)throw new TypeError('Approved plan phase is missing or ambiguous');
  const selected=matches[0];
  const section=heading=>lines.slice(heading.index,headings.find(next=>next.index>heading.index&&next.level<=heading.level)?.index??lines.length).join('\n');
  const shared=headings.filter(heading=>heading.level===2&&['Constraints & assumptions','Constraints and assumptions','Verification'].includes(heading.title)&&heading!==selected);
  const result=[...shared.filter(heading=>heading.index<selected.index).map(section),section(selected),...shared.filter(heading=>heading.index>selected.index).map(section)].join('\n\n');
  if(new TextEncoder().encode(result).length>32*1024)throw new TypeError('Approved plan section exceeds 32 KiB');
  return result;
};

export const verifyApprovedPlanRef = async value => {
  validateApprovedPlanRef(value);
  if(!value)return;
  const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.content));
  const actual=Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(actual!==value.contentHash)throw new TypeError('Approved plan content identity mismatch');
};
