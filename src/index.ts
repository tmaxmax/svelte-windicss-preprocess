import MagicString from 'magic-string';
import { variants } from 'windicss/src/processor/variants';

import { walk, parse } from 'svelte/compiler';
import { StyleSheet } from 'windicss/src/utils/style';
import { compile, interpret, preflight } from 'windicss/src';
import { CSSParser } from 'windicss/src/utils/css';
import { optimizeBuild } from 'windicss/src/utils/algorithm';

import type { TemplateNode } from 'svelte/types/compiler/interfaces'
import type { Preprocessor } from 'svelte/types/compiler/preprocess';

interface ChildNode {
  start:number;
  end:number;
  data:string;
  name?:string;
}

const mode = process.env.NODE_ENV;
const dev = mode === 'development';
const variantKeys = [...Object.keys(variants), 'xxl'];

let IGNORED_CLASSES:string[] = [];
let STYLESHEETS:StyleSheet[] = [];
let DIRECTIVES:StyleSheet[] = [];
let FILES:(string|undefined)[] = [];

let TAGNAMES:{[key:string]:string|undefined} = {};
let OPTIONS = {
  compile: true,
  globalPreflight: true,
  globalUtility: true, 
  prefix: 'windi-',
};

function combineStyleList(stylesheets:StyleSheet[]) {
  // Fix reduce of empty array with no initial value
  if (stylesheets.length === 0) return;
  return stylesheets.reduce((previousValue, currentValue) => previousValue.extend(currentValue)).combine();//.sort();
}

function globalStyleSheet(styleSheet:StyleSheet) {
  // turn all styles in stylesheet to global style
  styleSheet.children.forEach(style=>{
    style.wrap = (rule:string)=>`:global(${rule})`;
  });
  return styleSheet;
}

function compilation(classNames:string) {
  const utility = compile(classNames, OPTIONS.prefix, false);
  IGNORED_CLASSES = [...IGNORED_CLASSES, ...utility.ignored];
  STYLESHEETS.push(OPTIONS.globalUtility?globalStyleSheet(utility.styleSheet):utility.styleSheet);
  return utility.className ? [utility.className, ...utility.ignored].join(' ') : utility.ignored.join(' '); // return new className
}

function interpretation(classNames:string) {
  const utility = interpret(classNames);
  IGNORED_CLASSES = [...IGNORED_CLASSES, ...utility.ignored];
  let styleSheet = utility.styleSheet;
  STYLESHEETS.push(OPTIONS.globalUtility?globalStyleSheet(styleSheet):styleSheet);
}

function getReduceValue(node:TemplateNode, key="consequent"):TemplateNode|string|undefined {
  if (!node) return;
  const value = node[key];
  if (!value) return;
  if (value.raw) return value.value;
  return getReduceValue(value, key);
}

function addVariant(classNames:string, variant:string) {
  // prepend variant before each className
  const groupRegex = /[\S]+:\([\s\S]*?\)/g;
  const groups = [...classNames.match(groupRegex)??[]];
  const utilities = classNames.replace(groupRegex, '').split(/\s+/).filter(i=>i);
  return [...utilities, ...groups].map(i=>`${variant}:${i}`).join(' ');
}

const _preprocess:Preprocessor = ({content, filename}) => {
  const styleRegex = /<style[^>]*?(\/|(>([\s\S]*?)<\/style))>/;
  let updatedTags = [];
  let style = content.match(styleRegex)?.[0];
  if (style) {
    // handle tailwind directives ...
    style = style.replace(/<\/?style[^>]*>/g, '');
    STYLESHEETS.push(new CSSParser(style).parse(undefined, true));
    content = content.replace(styleRegex, '');
  }
  const parsed = parse(content);
  const code = new MagicString(content);
  
  walk(parsed.html, {
    enter(node:TemplateNode) {
      if (node.type === 'Element') {
        if (!TAGNAMES[node.name]) {
          TAGNAMES[node.name] = filename;
          updatedTags.push(node.name); // only work on production
        };
      
        let classes:string[] = [];
        let classStart:number|undefined;
        
        node.attributes.forEach((i:any)=>{
          if (i.name === 'class' || i.name === 'tw') {
            classStart = i.start;
            classes = [...classes, ...i.value.map(({data}:ChildNode)=>data)];
            code.overwrite(i.start, i.end, '');
          } else if (variantKeys.includes(i.name)) {
            // handle variant properties
            classStart = i.start;
            classes = [...classes, ...i.value.map(({data}:ChildNode)=>addVariant(data, i.name === 'xxl' ? '2xl' : i.name))];
            code.overwrite(i.start, i.end, '');
          }
        });
    
        if (classStart) {
          if (OPTIONS.compile) {
            code.prependLeft(classStart, `class="${compilation(classes.join(' '))}"`);
          } else {
            interpretation(classes.join(' '));
            code.prependLeft(classStart, `class="${classes.join(' ')}"`);
          }
        }
      }

      if (node.type === 'Class') {
        // handle class directive
        const utility = interpret(node.name);
        IGNORED_CLASSES = [...IGNORED_CLASSES, ...utility.ignored];
        DIRECTIVES.push(utility.styleSheet);
        // make sure directives add after all classes.
      }

      if (node.type==="ConditionalExpression") {
        // handle inline conditional expression
        const utility = interpret(`${getReduceValue(node, 'consequent')} ${getReduceValue(node, 'alternate')}`);
        IGNORED_CLASSES = [...IGNORED_CLASSES, ...utility.ignored];
        DIRECTIVES.push(utility.styleSheet);
      }

    }
  });

  if (FILES.indexOf(filename) !== -1) {
    // hot reload
    for (let [key,value] of Object.entries(TAGNAMES)) {
      if (value === filename) updatedTags.push(key);
    }
  };

  // preflights might lost when refresh
  const preflights = preflight(dev?Object.keys(TAGNAMES):updatedTags, FILES.length === 0 || FILES.indexOf(filename) === 0); // only enable global styles for first file
  
  const outputCSS = optimizeBuild(
                      (OPTIONS.globalPreflight? globalStyleSheet(preflights) : preflights)
                      .extend(combineStyleList(STYLESHEETS))
                      .extend(combineStyleList(DIRECTIVES))
                    );
   
  code.trimEnd().append(`\n\n<style>\n${outputCSS}</style>`);


  if (!FILES.includes(filename)) FILES.push(filename);
  
  // clear lists until next call
  STYLESHEETS = [];
  DIRECTIVES = [];
  return {code: code.toString()};
}

export function preprocess(options={}) {
  OPTIONS = {...OPTIONS, ...options}; // change global settings here;
  return _preprocess;
}