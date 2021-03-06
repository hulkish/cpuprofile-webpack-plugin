import { computed, observable } from "mobx";
import {
  Profile,
  convertToMergedFlameGraph,
  FlameGraphNode
} from "cpuprofile-to-flamegraph";

export class ProfileStore {
  cpuProfile: Profile;
  /**
   * Pause time in micro seconds (100000 = 1s)
   */
  @observable minimalPauseTime: number = 100000;
  @observable slot: number = 0;
  @observable showGarbageCollector: boolean = true;
  @observable hideSmallSlots: boolean = true;

  constructor(cpuProfile: Profile) {
    this.cpuProfile = cpuProfile;
  }

  @computed get filteredCpuProfile(): Profile {
    if (this.showGarbageCollector) {
      return this.cpuProfile;
    }
    // Get profile without garbage collector entries
    const garbageCollectorIds = this.cpuProfile.nodes
      .filter(node => node.callFrame.functionName === "(garbage collector)")
      .map(node => node.id);
    const filteredSamples: Array<number> = [];
    const filteredTimeDeltas: Array<number> = [];
    for (let i = 0; i < this.cpuProfile.samples.length; i++) {
      const sampleId = this.cpuProfile.samples[i];
      if (garbageCollectorIds.indexOf(sampleId) === -1) {
        filteredSamples.push(sampleId);
        filteredTimeDeltas.push(this.cpuProfile.timeDeltas[i]);
      }
    }
    return {
      ...this.cpuProfile,
      samples: filteredSamples,
      timeDeltas: filteredTimeDeltas
    };
  }

  /**
   * Get the merged flameGraph root node
   */
  @computed get mergedFlameGraph() {
    const graph = convertToMergedFlameGraph(this.filteredCpuProfile);
    graph.children.unshift({
      value: 0,
      name: "(init)",
      executionTime: 0,
      children: [],
      profileNode: {
        id: -1,
        callFrame: {
          scriptId: "-1",
          functionName: "(init)",
          lineNumber: -1,
          columnNumber: -1,
          url: ""
        }
      }
    });
    return graph;
  }

  /**
   * Return the execution time of the entire profile
   */
  @computed get executionTime(): number {
    return (this.cpuProfile.endTime - this.cpuProfile.startTime) / 60000;
  }

  @computed get slots() {
    const children = this.mergedFlameGraph.children;
    let currentExecutionSum = 0;
    let currentSlotStart = 0;
    const slots: Array<{ start: number; end: number; duration: number }> = [];
    for (let i = 0; i <= children.length; i++) {
      const node = children[i];
      if (
        node === undefined ||
        (node.name === "(program)" &&
          node.executionTime > this.minimalPauseTime)
      ) {
        if (currentSlotStart !== i) {
          slots.push({
            start: currentSlotStart,
            end: i - 1,
            duration: currentExecutionSum
          });
        }
        currentExecutionSum = 0;
        currentSlotStart = i + 1;
      } else {
        currentExecutionSum += node.executionTime;
      }
    }
    const filteredSlots =
      this.hideSmallSlots === false
        ? slots
        : slots.filter((slot, i) => slot.duration > 50000);
    filteredSlots.unshift({
      start: 0,
      end: 0,
      duration: 0
    });
    return filteredSlots;
  }

  /**
   * Returns the flame graph of the active slot
   */
  @computed get activeSlotFlameGraph() {
    const activeSlot = Math.min(this.slots.length - 1, this.slot);
    const breakIndex = this.slots[activeSlot];
    const childNodes = this.mergedFlameGraph.children.filter(
      (_, i) => i >= breakIndex.start && i <= breakIndex.end
    );
    return Object.assign({}, this.mergedFlameGraph, { children: childNodes });
  }

  /**
   * Active slot execution time
   */
  @computed get activeSlotExecutionTime() {
    function getNodeTime(node: FlameGraphNode) {
      return (
        node.value +
        node.children.reduce(
          (sum, childNode) => sum + getNodeTime(childNode),
          0
        )
      );
    }
    return getNodeTime(this.activeSlotFlameGraph);
  }

  @computed get durationSummary() {
    const webpackModules = [
      "webpack",
      "loader-runner",
      "tapable",
      "webpack-dev-middleware"
    ];
    function getNodeTime(node: FlameGraphNode) {
      const isLoader = node.nodeModule && /\-loader$/.test(node.nodeModule);
      if (isLoader) {
        return {
          [node.nodeModule!]: node.executionTime
        };
      }
      if (node.name === "(garbage collector)") {
        return {
          garbageCollector: node.executionTime
        };
      }

      if (node.children.length === 0) {
        const isWebpack =
          node.nodeModule && webpackModules.indexOf(node.nodeModule) !== -1;
        if (isWebpack) {
          return {
            webpack: node.executionTime
          };
        } else {
          return {
            unkown: node.executionTime
          };
        }
      }

      const recursiveChildTimes = node.children.reduce(
        (sum, childNode) => {
          const childTimes = getNodeTime(childNode);
          Object.keys(childTimes).forEach(type => {
            sum[type] = (sum[type] || 0) + childTimes[type];
          });
          return sum;
        },
        {
          unkown: 0
        }
      );

      const isWebpack =
        node.nodeModule && webpackModules.indexOf(node.nodeModule) !== -1;
      if (recursiveChildTimes.unkown && isWebpack) {
        return {
          ...recursiveChildTimes,
          webpack: recursiveChildTimes.unkown,
          unkown: 0
        };
      }

      return recursiveChildTimes;
    }
    const nodeTimes = getNodeTime(this.activeSlotFlameGraph);
    const sum = Math.max(
      1,
      Object.keys(nodeTimes).reduce(
        (sum, timeName) => sum + nodeTimes[timeName],
        0
      )
    );
    const result = Object.keys(nodeTimes).map(timeName => {
      return {
        name: timeName,
        duration: nodeTimes[timeName],
        relative: Math.round((nodeTimes[timeName] / sum) * 100) + "%"
      };
    });
    result.sort((a, b) =>
      a.duration > b.duration ? -1 : a.duration < b.duration ? 1 : 0
    );
    return result;
  }
}
