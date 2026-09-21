import {CodeMirrorEditor} from '@/components/ui/CodeMirrorEditor.tsx';
import {type EditorView, keymap} from '@codemirror/view';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DndContext } from '@dnd-kit/core';
import { Ghostty, Terminal, FitAddon } from '@/lib/ghostty/index.ts';
import { SerializeAddon } from '@/lib/terminal/SerializeAddon.ts';
import { VirtualSessionList } from '@/components/session/sidebar/VirtualSessionList.tsx';
import { SidebarRowsContext } from '@/components/session/sidebar/SidebarRowsContext.tsx';
import { createSidebarRowModel } from '@/components/session/sidebar/sidebarRowModel.ts';
const nodes = Array.from({length:1000},(_,i)=>({session:{id:`session_${i}`,directory:'/fixture',title:`Session ${i}`,time:{created:i,updated:i}},children:[]}));
const model = createSidebarRowModel();model.set('fixture',0,nodes.map(n=>({id:n.session.id,scope:'/fixture',archived:false,selectable:true,descendants:[]})));
const sidebarState = { prepend: () => {}, taller: () => {}, clear: () => {}, exits: 0 };
function SidebarFixture() {
  const [current,setNodes] = React.useState(nodes);
  const [height,setHeight] = React.useState(0);
  sidebarState.prepend = () => setNodes(previous => [{session:{...nodes[0].session,id:'prepended',title:'Prepended session'},children:[]},...previous]);
  sidebarState.taller = () => setHeight(60);
  sidebarState.clear = () => setNodes([]);
  React.useLayoutEffect(()=>model.set('fixture',0,current.map(n=>({id:n.session.id,scope:'/fixture',archived:false,selectable:true,descendants:[]}))),[current]);
  const context={model,expanded:new Set<string>(),search:false,editingId:null,menuKey:null,currentSessionId:null};
  return <DndContext><SidebarRowsContext.Provider value={context}><VirtualSessionList nodes={current} onExitComplete={()=>sidebarState.exits++} directory="/fixture" renderNode={node=><div data-session-row={node.session.id}><button data-session-select style={{height:(Number(node.session.id.split('_')[1])%7===0?54:32)+height}}>{node.session.title}</button></div>}/></SidebarRowsContext.Provider></DndContext>;
}
createRoot(document.querySelector('#sidebar')!).render(<SidebarFixture/>);
const links:string[]=[];
const theme={foreground:'#dddfee',background:'#101218',cursor:'#a4bcff',cursorAccent:'#101218',selectionBackground:'#5873b780',black:'#242735',red:'#ff7b89',green:'#9adeaf',yellow:'#edca86',blue:'#9ab8ff',magenta:'#d6a1e3',cyan:'#8dd9df',white:'#dddfee',brightBlack:'#748095',brightRed:'#ff7b89',brightGreen:'#9adeaf',brightYellow:'#edca86',brightBlue:'#9ab8ff',brightMagenta:'#d6a1e3',brightCyan:'#8dd9df',brightWhite:'#ffffff'};
const terminal = new Terminal({ghostty:await Ghostty.load(),theme,fontFamily:'Menlo, monospace',fontSize:14,lineHeight:1.15,onLinkActivate:url=>links.push(url)});
const inputs:string[]=[],sizes:object[]=[];terminal.onData(s=>inputs.push(s));terminal.onResize(s=>sizes.push(s));
const fit=new FitAddon();terminal.loadAddon(fit);await terminal.open(document.querySelector('#terminal')!);const serializer=new SerializeAddon();serializer.activate(terminal);
terminal.write('\x1b[32mDevRyan terminal parity fixture\x1b[0m\r\nUTF-8: café 漢字 👩‍💻\r\n\x1b[34m┌────────────────────────┐\r\n│  line drawing + colors  │\r\n└────────────────────────┘\x1b[0m\r\nReady> ');
Object.assign(window,{fixture:{terminal,fit,inputs,sizes,serializer,model,nodes,sidebarState,links,ready:true}});

const initialSource = 'first\r\nsecond\n' + 'x'.repeat(250_000) + '\r\nno final newline';
const editorState = { source: initialSource, view: null as EditorView | null, escapeHandled: 0, escaped: 0 };
function EditorFixture() {
  const [value,setValue] = React.useState(initialSource);
  return <CodeMirrorEditor value={value} onChange={next=>{editorState.source=next;setValue(next)}} extensions={[keymap.of([{key:"Escape",run:()=>{editorState.escapeHandled++;return true}}])]} onViewReady={view=>{editorState.view=view}} />;
}
Object.assign(window,{editorFixture:editorState});
createRoot(document.querySelector('#editor')!).render(<EditorFixture/>);

document.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented) editorState.escaped++; });
