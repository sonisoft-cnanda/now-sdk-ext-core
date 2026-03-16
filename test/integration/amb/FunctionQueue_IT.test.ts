import {FunctionQueue} from "../../../src/sn/amb/FunctionQueue";

describe.skip('FunctionQueue', () => {
	it('test initial state', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		expect(funQueue.getSize()).toBe(0);
		expect(funQueue.getCapacity()).toBe(queueCapacity);
		expect(funQueue.getAvailableSpace()).toBe(queueCapacity);
	});

	it('test bad ctor argument', () => {
		let funQueue = new FunctionQueue(0);
		expect(funQueue.getSize()).toBe(0);
		expect(funQueue.getCapacity()).toBe(1);
	});

	it('test state after enqueue', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		funQueue.enqueue("item#1");
		expect(funQueue.getSize()).toBe(1);
		expect(funQueue.getAvailableSpace()).toBe(queueCapacity - 1);
	});

	it('test after dequeue', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		funQueue.enqueue("item#1");
		funQueue.enqueue("item#2");
		expect(funQueue.dequeue()).toEqual("item#1");
		expect(funQueue.getSize()).toBe(1);
	});

	it('test state after enqueueMultiple', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		const inputItems = ["item#1", "item#2", "item#3", "item#4"];
		funQueue.enqueueMultiple(inputItems);
		expect(funQueue.getSize()).toBe(4);
		expect(funQueue.dequeue()).toEqual("item#1");
	});

	it('test after dequeueMultiple', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		const inputItems = ["item#1", "item#2", "item#3", "item#4"];
		inputItems.forEach((item) => funQueue.enqueue(item));
		const numToGrab = inputItems.length - 1;
		const outputItems = funQueue.dequeueMultiple(numToGrab);
		expect(funQueue.getSize()).toBe(1);
		expect(outputItems.length).toBe(numToGrab);
		let idx;
		for (idx = 0; idx < numToGrab; ++idx)
			expect(outputItems[idx] == inputItems[idx]);
	});

	it('test out of range arg dequeueMultiple', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		const inputItems = ["item#1", "item#2", "item#3", "item#4"];
		const emptyArray = [];
		funQueue.enqueueMultiple(inputItems);
		expect(funQueue.dequeueMultiple(-7)).toBeUndefined();
		expect(funQueue.dequeueMultiple(queueCapacity + 1)).toBeUndefined();
	});

	it('test singular forms near boundaries', () => {
		const queueCapacity = 4;
		const funQueue = new FunctionQueue(queueCapacity);
		let inputItems = ["item#1", "item#2", "item#3", "item#4", "item#5"];
		let idx;
		for (idx = 0; idx < queueCapacity; ++idx)
			expect(funQueue.enqueue(inputItems[idx])).toBe(true);
		expect(funQueue.enqueue(inputItems[queueCapacity])).toBe(false);
		while (queueCapacity < inputItems.length)
			inputItems.pop();
		for (idx = 0; idx < queueCapacity; ++idx)
			expect(funQueue.dequeue()).toEqual(inputItems[idx]);
		expect(funQueue.getSize()).toBe(0);
		expect(funQueue.dequeue()).toBeUndefined();
		expect(funQueue.getSize()).toBe(0);
	});

	it('test multiple forms near boundaries', () => {
		const queueCapacity = 4;
		const funQueue = new FunctionQueue(queueCapacity);
		let inputItems = ["item#1", "item#2", "item#3", "item#4", "item#5"];
		expect(funQueue.enqueueMultiple(inputItems)).toBe(false);
		while (queueCapacity < inputItems.length)
			inputItems.pop();
		expect(funQueue.enqueueMultiple(inputItems)).toBe(true);
		expect(funQueue.getSize()).toBe(inputItems.length);
		expect(funQueue.getAvailableSpace()).toBe(queueCapacity - inputItems.length);
		expect(funQueue.dequeueMultiple(queueCapacity + 1)).toBeUndefined();
		expect(funQueue.getSize()).toBe(inputItems.length);
		expect(funQueue.dequeueMultiple(queueCapacity)).toEqual(inputItems);
		expect(funQueue.getSize()).toBe(0);
	});

	it('test after dequeueMultiple', () => {
		const queueCapacity = 8;
		const funQueue = new FunctionQueue(queueCapacity);
		const inputItems = ["item#1", "item#2", "item#3", "item#4"];
		inputItems.forEach((item) => funQueue.enqueue(item));
		const numToGrab = inputItems.length - 1;
		const outputItems = funQueue.dequeueMultiple(numToGrab);
		expect(funQueue.getSize()).toBe(1);
		expect(outputItems.length).toBe(numToGrab);
		let idx;
		for (idx = 0; idx < numToGrab; ++idx)
			expect(outputItems[idx] == inputItems[idx]);
	});
});