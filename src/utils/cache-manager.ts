interface CacheOptions {
    maxAge?: number // Cache duration in seconds
    staleWhileRevalidate?: number // SWR duration in seconds
    cacheKeyPrefix?: string
    customHeaders?: Record<string, string>
}

interface CacheStats {
    hit: boolean
    age?: number
    size?: number
    key: string
}

export class CloudflareCacheManager {
    private cache: Cache
    private defaultOptions: Required<CacheOptions>

    constructor(options: CacheOptions = {}) {
        this.cache = caches.default
        this.defaultOptions = {
            maxAge: 86400, // 24 hours
            staleWhileRevalidate: 3600, // 1 hour
            cacheKeyPrefix: 'cf-cache',
            customHeaders: {},
            ...options
        }
    }

    /**
     * Generate a cache key from URL
     */
    private generateCacheKey(url: string, suffix?: string): string {
        const encodedUrl = btoa(url).replace(/[^a-zA-Z0-9]/g, '_')
        const key = `https://${this.defaultOptions.cacheKeyPrefix}.cache/${encodedUrl}`
        return suffix ? `${key}/${suffix}` : key
    }

    /**
     * Get item from cache
     */
    async get(url: string, suffix?: string): Promise<Response | null> {
        try {
            const cacheKey = this.generateCacheKey(url, suffix)
            const cachedResponse = await this.cache.match(cacheKey)

            if (cachedResponse) {
                // Check if cache is stale
                const cacheDate = cachedResponse.headers.get('CF-Cache-Date')
                if (cacheDate) {
                    const age = (Date.now() - parseInt(cacheDate)) / 1000
                    const isStale = age > this.defaultOptions.maxAge

                    // Add cache status headers
                    const headers = new Headers(cachedResponse.headers)
                    headers.set('CF-Cache-Status', isStale ? 'STALE' : 'HIT')
                    headers.set('CF-Cache-Age', Math.floor(age).toString())

                    return new Response(cachedResponse.body, {
                        status: cachedResponse.status,
                        headers
                    })
                }
            }

            return null
        } catch (error) {
            console.error('Cache get error:', error)
            return null
        }
    }

    /**
     * Store item in cache
     */
    async put(
        url: string,
        response: Response,
        options: Partial<CacheOptions> = {},
        suffix?: string
    ): Promise<boolean> {
        try {
            const cacheKey = this.generateCacheKey(url, suffix)
            const mergedOptions = { ...this.defaultOptions, ...options }

            // Clone response to avoid consuming the original
            const responseToCache = response.clone()

            // Prepare headers for caching
            const headers = new Headers(responseToCache.headers)

            // Add cache control headers
            headers.set('Cache-Control', `public, max-age=${mergedOptions.maxAge}`)
            headers.set('CF-Cache-Date', Date.now().toString())
            headers.set('CF-Cache-TTL', mergedOptions.maxAge.toString())

            // Add custom headers
            Object.entries(mergedOptions.customHeaders).forEach(([key, value]) => {
                headers.set(key, value)
            })

            // Create cached response
            const cachedResponse = new Response(responseToCache.body, {
                status: responseToCache.status,
                headers
            })

            // Store in cache
            await this.cache.put(cacheKey, cachedResponse)
            return true

        } catch (error) {
            console.error('Cache put error:', error)
            return false
        }
    }

    /**
     * Delete item from cache
     */
    async delete(url: string, suffix?: string): Promise<boolean> {
        try {
            const cacheKey = this.generateCacheKey(url, suffix)
            return await this.cache.delete(cacheKey)
        } catch (error) {
            console.error('Cache delete error:', error)
            return false
        }
    }

    /**
     * Get cache statistics for a URL
     */
    async getStats(url: string, suffix?: string): Promise<CacheStats> {
        const cacheKey = this.generateCacheKey(url, suffix)
        const cachedResponse = await this.cache.match(cacheKey)

        if (!cachedResponse) {
            return { hit: false, key: cacheKey }
        }

        const cacheDate = cachedResponse.headers.get('CF-Cache-Date')
        const age = cacheDate ? (Date.now() - parseInt(cacheDate)) / 1000 : undefined
        const size = cachedResponse.headers.get('Content-Length')

        return {
            hit: true,
            age,
            size: size ? parseInt(size) : undefined,
            key: cacheKey
        }
    }

    /**
     * Fetch with cache - main method for cached requests
     */
    async fetchWithCache(
        url: string,
        fetchOptions: RequestInit = {},
        cacheOptions: Partial<CacheOptions> = {},
        suffix?: string
    ): Promise<Response> {
        // Try to get from cache first
        const cachedResponse = await this.get(url, suffix)

        if (cachedResponse) {
            const cacheStatus = cachedResponse.headers.get('CF-Cache-Status')

            // If cache is still fresh, return it
            if (cacheStatus === 'HIT') {
                return cachedResponse
            }

            // If cache is stale but within SWR window, return stale and revalidate in background
            if (cacheStatus === 'STALE') {
                const age = parseInt(cachedResponse.headers.get('CF-Cache-Age') || '0')
                if (age <= this.defaultOptions.staleWhileRevalidate) {
                    // Return stale response immediately
                    const staleResponse = cachedResponse.clone()
                    const headers = new Headers(staleResponse.headers)
                    headers.set('CF-Cache-Status', 'STALE-WHILE-REVALIDATE')

                    // Revalidate in background (non-blocking)
                    this.revalidateInBackground(url, fetchOptions, cacheOptions, suffix)

                    return new Response(staleResponse.body, {
                        status: staleResponse.status,
                        headers
                    })
                }
            }
        }

        // Cache miss or expired - fetch from origin
        return this.fetchAndCache(url, fetchOptions, cacheOptions, suffix)
    }

    /**
     * Fetch from origin and cache the response
     */
    private async fetchAndCache(
        url: string,
        fetchOptions: RequestInit = {},
        cacheOptions: Partial<CacheOptions> = {},
        suffix?: string
    ): Promise<Response> {
        try {
            const response = await fetch(url, fetchOptions)

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            // Cache the response (non-blocking)
            this.put(url, response.clone(), cacheOptions, suffix)
                .catch(err => console.error('Background cache storage failed:', err))

            // Add cache miss header
            const headers = new Headers(response.headers)
            headers.set('CF-Cache-Status', 'MISS')

            return new Response(response.body, {
                status: response.status,
                headers
            })

        } catch (error) {
            console.error('Fetch and cache error:', error)
            throw error
        }
    }

    /**
     * Revalidate cache in background
     */
    private async revalidateInBackground(
        url: string,
        fetchOptions: RequestInit = {},
        cacheOptions: Partial<CacheOptions> = {},
        suffix?: string
    ): Promise<void> {
        try {
            const response = await fetch(url, fetchOptions)
            if (response.ok) {
                await this.put(url, response, cacheOptions, suffix)
            }
        } catch (error) {
            console.error('Background revalidation failed:', error)
        }
    }

    /**
     * Purge cache entries matching a pattern
     */
    async purgeByPattern(pattern: string): Promise<number> {
        // Note: This is a conceptual method as CF Cache API doesn't support pattern matching
        // In practice, you'd need to track cache keys separately or use CF's purge API
        console.warn('Pattern-based purging not directly supported by CF Cache API')
        return 0
    }

    /**
     * Get cache configuration
     */
    getConfig(): Required<CacheOptions> {
        return { ...this.defaultOptions }
    }

    /**
     * Update cache configuration
     */
    updateConfig(options: Partial<CacheOptions>): void {
        this.defaultOptions = { ...this.defaultOptions, ...options }
    }
}
