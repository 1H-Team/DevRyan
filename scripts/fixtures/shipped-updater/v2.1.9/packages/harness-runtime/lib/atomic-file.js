// Stand-in for the shipped module: discovery never writes, so only the import has to resolve.
export async function writeFileAtomic() {
  throw new Error('The shipped discovery fixture cannot write files');
}
