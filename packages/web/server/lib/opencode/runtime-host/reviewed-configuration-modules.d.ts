declare module 'devryan:reviewed-ponytail-instructions' {
 const instructions:Readonly<Record<'lite'|'full'|'ultra'|'review',string>>;
 export default instructions;
 export const commands:Readonly<Record<string,{readonly description:string;readonly template:string}>>;
 export const command:{readonly description:string;readonly template:string};
}
