import { AutoRouter, cors, status } from 'itty-router'
import { download } from './routes/download'

const { preflight, corsify } = cors({
	allowMethods: ['GET']
})
const router = AutoRouter({
	before: [preflight],
	finally: [corsify]
})

router
	.get('/download/:urlHASH', download)
	.get('/', () => status(404))


export default { ...router }

