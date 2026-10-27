<script setup lang="ts">
// An application's 3D button (F628): disabled while the controls' tilt policy keeps the view flat.
import { useTiltAvailable } from '@vibeglobe/vue';

const available = useTiltAvailable();
</script>

<template>
  <button class="tilt-3d" type="button" :disabled="!available" :data-available="available">3D</button>
</template>

<style scoped>
.tilt-3d {
  position: absolute;
  right: 8px;
  top: 8px;
}
</style>
