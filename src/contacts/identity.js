// Exact identifiers only. Never infer an email alias or a telephone country code.
export function normalizeIdentity(kind,value) {
 if(typeof value!=='string' || value.length>254) return null;
 const text=value.trim();
 if(kind==='email') return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(text)?text.toLowerCase():null;
 if(kind==='phone') {
  const phone=text.replace(/[\s().-]/g,'').replace(/^00/,'+');
  return /^\+[1-9]\d{6,14}$/.test(phone)?phone:null;
 }
 return null;
}
