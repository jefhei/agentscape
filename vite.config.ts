import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Bundle code-splitting (M3-T4 perf deliverable): the heavy
        // three.js stack and the postprocessing chain are split out of
        // the app shell so the shell itself stays small and each chunk
        // is cached independently across deploys. The function form is
        // used (not the object form) so deep subpath imports like
        // three/examples/jsm/utils/BufferGeometryUtils.js land in the
        // right chunk too.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three'
          if (id.includes('node_modules/@react-three/postprocessing')) {
            return 'postprocessing'
          }
          if (id.includes('node_modules/postprocessing')) return 'postprocessing'
          if (id.includes('node_modules/@react-three/drei')) return 'drei'
          if (id.includes('node_modules/@react-three/fiber')) return 'r3f'
          if (id.includes('node_modules/react')) return 'react'
          return undefined
        },
      },
    },
  },
})
