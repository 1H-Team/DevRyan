// Build-only entry: Bun seals the exact reviewed transforms into a Node asset.
// Importing this module does not register plugins or acquire native services.
import * as originals from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import instructions,{command,commands} from 'devryan:reviewed-ponytail-instructions';
import {reviewedSlimCommandDeclarations} from './native-slim-commands.js';
declare const DEVRYAN_NATIVE_BUILD_ID:string;
export const nativeBuildID=typeof DEVRYAN_NATIVE_BUILD_ID==='string'?DEVRYAN_NATIVE_BUILD_ID:undefined;
export {resolveReviewedSlimAgents as resolveSlimAgents} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
export const slimCommandDeclarations=reviewedSlimCommandDeclarations({deepwork:originals.createDeepworkCommandHook,loop:originals.createLoopCommandHook,reflect:originals.createReflectCommandHook});
export const ponytailInstructions=instructions;
export const ponytailCommandDeclaration=command;

export const ponytailCommands=commands;

export {createReviewedDocumentCache} from '../../../default-config/plugins/devryan-document-reader.mjs';

export {reviewedSlimInterviewCommandDeclaration as interviewCommandDeclaration} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

export {formatReviewedSlimTaskBoard,createReviewedSlimTaskBoardRenderer,selectReviewedSlimFallback,isReviewedSlimFailoverError} from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

import {createDocumentTool,processFilePart,withReviewedDocumentOwner} from '../../../default-config/plugins/devryan-document-reader.mjs';
export const reviewedDocumentOriginals=Object.freeze({createDocumentTool,processFilePart,withReviewedDocumentOwner});
export {createOwnedNativeDocument} from './native-document.js';

/** Original service + listener-free HTTP/UI handler, with constructor-owned IO. */
export const reviewedSlimInterviewOriginals=Object.freeze({createInterviewService:originals.createInterviewService,createInterviewHandler:originals.createInterviewHandler,resolveExistingInterviewPath:originals.resolveReviewedExistingInterviewPath,InterviewDocumentOwnershipError:originals.InterviewDocumentOwnershipError});

import {withReviewedImagegenOwner,callReviewedImagegenResponses} from "../../../../runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js";
export const reviewedImagegenOriginals=Object.freeze({withReviewedImagegenOwner,callReviewedImagegenResponses});
