import { AutoRouter, cors, status } from 'itty-router'
import { download } from './routes/download'
import { upload } from './routes/upload'

// Export the Durable Object class for request coalescing
export { DownloadCoalescer } from './coalescer'

const { preflight, corsify } = cors({
	allowMethods: ['GET', 'PUT', 'OPTIONS'],
})
const router = AutoRouter({
	before: [preflight],
	finally: [corsify]
})

router
	.get('/download/:urlHASH', download)
	.put('/upload/:urlHASH', upload)
	.all('*', () => status(404))


export default { ...router }
