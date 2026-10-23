<script setup lang="ts">
import { FEATURE_GROUPS } from '../utils/feature-groups';
</script>

<template>
  <main class="home-page">
    <h1>VibeGlobe with Nuxt</h1>
    <p>
      The globe page renders the globe component with server-side rendering. Each feature group of the engine has a
      page:
    </p>
    <ul>
      <li v-for="group in FEATURE_GROUPS" :key="group.id">
        <NuxtLink :to="`/features/${group.id}`" :class="`to-${group.id}`">{{ group.title }}</NuxtLink
        >: {{ group.summary }}
      </li>
    </ul>
  </main>
</template>
