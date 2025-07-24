// Cache helper functions for B2/R2 files

export function generateCacheKey(pathname: string): string {
    const hash = btoa(pathname).replace(/[^a-zA-Z0-9]/g, '')
    return `https://cache.movieworker.dev/v1/b2_${hash}_v6`
}

export async function getCachedResponse(cacheKey: string, allowExpired: boolean = false): Promise<Response | null> {
    try {
        const cache = caches.default
        const request = new Request(cacheKey)
        const response = await cache.match(request)

        if (!response) return null

        // Check if cache is expired
        const cachedAt = response.headers.get('x-cached-at')
        const cacheTtl = parseInt(response.headers.get('x-cache-ttl') || '3600')

        if (cachedAt) {
            const cacheAge = (Date.now() - new Date(cachedAt).getTime()) / 1000

            if (cacheAge < cacheTtl) {
                return response // Fresh cache
            } else if (allowExpired) {
                return response // Expired but allowed
            } else {
                return null // Expired and not allowed
            }
        }

        return allowExpired ? response : null
    } catch (error) {
        console.error('Cache lookup error:', error)
        return null
    }
}

export async function cacheB2Response(cacheKey: string, response: Response, maxAge: number): Promise<void> {
    try {
        const cache = caches.default
        const request = new Request(cacheKey)

        const originalHeaders = Object.fromEntries(response.headers.entries())
        const cacheResponse = new Response(response.body, {
            status: response.status,
            headers: {
                ...originalHeaders,
                'cache-control': `public, max-age=${maxAge}`,
                'x-cached-at': new Date().toISOString(),
                'x-cache-ttl': maxAge.toString(),
                'x-cache-source': 'worker-b2'
            },
        })

        await cache.put(request, cacheResponse)
        console.log('B2 file cached successfully in Worker cache')
    } catch (error) {
        console.error('Failed to cache B2 response:', error)
    }
}

export async function cacheR2Response(cacheKey: string, response: Response, maxAge: number): Promise<void> {
    try {
        const cache = caches.default
        const request = new Request(cacheKey)

        const originalHeaders = Object.fromEntries(response.headers.entries())
        const cacheResponse = new Response(response.body, {
            status: response.status,
            headers: {
                ...originalHeaders,
                'cache-control': `public, max-age=${maxAge}`,
                'x-cached-at': new Date().toISOString(),
                'x-cache-ttl': maxAge.toString(),
                'x-cache-source': 'worker-r2'
            },
        })

        await cache.put(request, cacheResponse)
        console.log('R2 file cached successfully in Worker cache')
    } catch (error) {
        console.error('Failed to cache R2 response:', error)
    }
}

export async function clearExpiredCache(): Promise<void> {
    try {
        const cache = caches.default
        // Note: Cache API doesn't have a direct way to list all keys
        // This would need to be implemented with a separate tracking mechanism
        // For now, we rely on natural TTL expiration
        console.log('Cache cleanup would run here if implemented')
    } catch (error) {
        console.error('Cache cleanup error:', error)
    }
}

export interface CacheStats {
    hits: number
    misses: number
    size: number
    lastCleanup: Date
}

// Simple in-memory cache stats (resets on worker restart)
let cacheStats: CacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    lastCleanup: new Date()
}

export function incrementCacheHit(): void {
    cacheStats.hits++
}

export function incrementCacheMiss(): void {
    cacheStats.misses++
}

export function getCacheStats(): CacheStats {
    return { ...cacheStats }
}

export function resetCacheStats(): void {
    cacheStats = {
        hits: 0,
        misses: 0,
        size: 0,
        lastCleanup: new Date()
    }
}
