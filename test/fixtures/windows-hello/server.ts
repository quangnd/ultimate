import { obj } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'

export default defineExtension({
  name: 'hello',
  tools: [
    defineTool({
      name: 'hello',
      description: 'Say hello from a user extension. Takes no arguments.',
      parameters: obj({}),
      execute: async function sayHello() {
        return { output: [{ type: 'text', text: 'hello from a user extension' }] }
      },
    }),
  ],
})
