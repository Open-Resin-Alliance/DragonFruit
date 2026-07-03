import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const hotkeyRestrictionPlugin = {
  rules: {
    "no-direct-window-document-hotkeys": {
      meta: {
        type: "problem",
        docs: {
          description: "Block direct window/document keydown or keyup event listeners and property assignments",
        },
        schema: [],
      },
      create(context) {
        const filename = context.filename || context.getFilename();
        const normalizedPath = filename.replace(/\\/g, "/");

        const isAllowed =
          normalizedPath.endsWith("hotkeyStore.ts") ||
          normalizedPath.endsWith("HotkeyRegistryManager.tsx") ||
          normalizedPath.includes("/__tests__/") ||
          normalizedPath.endsWith(".test.ts") ||
          normalizedPath.endsWith(".test.tsx") ||
          normalizedPath.endsWith(".spec.ts") ||
          normalizedPath.endsWith(".spec.tsx") ||
          normalizedPath.includes("/node_modules/");

        if (isAllowed) {
          return {};
        }

        return {
          CallExpression(node) {
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.object.type === "Identifier" &&
              (node.callee.object.name === "window" || node.callee.object.name === "document") &&
              node.callee.property.type === "Identifier" &&
              (node.callee.property.name === "addEventListener" || node.callee.property.name === "removeEventListener")
            ) {
              const firstArg = node.arguments[0];
              if (
                firstArg &&
                (
                  (firstArg.type === "Literal" && (firstArg.value === "keydown" || firstArg.value === "keyup")) ||
                  (firstArg.type === "TemplateLiteral" && firstArg.quasis.length === 1 && (firstArg.quasis[0].value.raw === "keydown" || firstArg.quasis[0].value.raw === "keyup"))
                )
              ) {
                context.report({
                  node,
                  message: "Direct window/document keydown/keyup listeners are forbidden. Use HotkeyRegistryManager or hotkeyStore. See /DragonFruit/docs/hotkeys/README.md",
                });
              }
            }
          },
          AssignmentExpression(node) {
            if (
              node.left.type === "MemberExpression" &&
              node.left.object.type === "Identifier" &&
              (node.left.object.name === "window" || node.left.object.name === "document") &&
              node.left.property.type === "Identifier" &&
              (node.left.property.name === "onkeydown" || node.left.property.name === "onkeyup")
            ) {
              context.report({
                node,
                message: "Direct window/document keydown/keyup property assignments are forbidden. Use HotkeyRegistryManager or hotkeyStore. See /DragonFruit/docs/hotkeys/README.md",
              });
            }
          }
        };
      }
    }
  }
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      "hotkey-restriction": hotkeyRestrictionPlugin,
    },
    rules: {
      "hotkey-restriction/no-direct-window-document-hotkeys": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "**/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project-specific ignores:
    "2. Backup/**",
  ]),
]);

export default eslintConfig;

